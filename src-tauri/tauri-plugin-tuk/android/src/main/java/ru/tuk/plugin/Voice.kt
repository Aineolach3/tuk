package ru.tuk.plugin

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.LinkedBlockingQueue

/**
 * Живой голос Тука: нейросетевой синтез (Piper через sherpa-onnx) прямо на телефоне.
 * Тембр персонажа: речь генерируется чуть медленнее (lengthScale = p) и проигрывается
 * с частотой ×p — высота голоса поднимается, а темп остаётся естественным.
 */
object Voice {
    data class Preset(val id: String, val model: String, val pitch: Float, val noise: Float = 0.72f)

    val PRESETS = mapOf(
        "tuk" to Preset("tuk", "dmitri", 1.22f),
        "bright" to Preset("bright", "irina", 1.18f),
        "boy" to Preset("boy", "denis", 1.3f),
        "calm" to Preset("calm", "dmitri", 1.0f, 0.6f),
    )

    private fun url(model: String) =
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-$model-medium.tar.bz2"

    @Volatile var state: String = "none" // none | downloading | ready | error
    @Volatile var progress: Int = 0
    @Volatile var error: String? = null

    private var tts: OfflineTts? = null
    private var ttsModel: String? = null
    private var track: AudioTrack? = null
    @Volatile private var speakId = 0

    fun dir(ctx: Context, model: String) = File(ctx.filesDir, "voices/$model")
    fun ready(ctx: Context, model: String) = File(dir(ctx, model), ".ok").exists()

    fun status(ctx: Context, preset: String): String {
        val p = PRESETS[preset] ?: PRESETS.getValue("tuk")
        if (state == "downloading") return state
        return if (ready(ctx, p.model)) "ready" else if (state == "error") "error" else "none"
    }

    /** Скачать голос (~67 МБ, tar.bz2) и распаковать. */
    fun download(ctx: Context, preset: String) {
        if (state == "downloading") return
        val p = PRESETS[preset] ?: return
        state = "downloading"
        progress = 0
        error = null
        Thread {
            val tmp = File(ctx.cacheDir, "voice-${p.model}.tar.bz2")
            try {
                val c = URL(url(p.model)).openConnection() as HttpURLConnection
                c.connectTimeout = 20000
                c.readTimeout = 60000
                c.instanceFollowRedirects = true
                val total = c.contentLengthLong.takeIf { it > 0 } ?: 67_000_000L
                c.inputStream.use { inp ->
                    FileOutputStream(tmp).use { out ->
                        val buf = ByteArray(128 * 1024)
                        var got = 0L
                        while (true) {
                            val n = inp.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            got += n
                            progress = ((got * 85) / total).toInt().coerceAtMost(85)
                        }
                    }
                }
                val d = dir(ctx, p.model)
                d.deleteRecursively()
                d.mkdirs()
                TarArchiveInputStream(BZip2CompressorInputStream(BufferedInputStream(tmp.inputStream()))).use { tar ->
                    while (true) {
                        val e = tar.nextEntry ?: break
                        // в архиве папка vits-piper-ru_RU-<имя>-medium/ — убираем её
                        val rel = e.name.substringAfter('/', "")
                        if (rel.isEmpty() || rel.contains("..")) continue
                        val f = File(d, rel)
                        if (e.isDirectory) f.mkdirs() else {
                            f.parentFile?.mkdirs()
                            FileOutputStream(f).use { tar.copyTo(it) }
                        }
                    }
                }
                if (d.listFiles()?.none { it.name.endsWith(".onnx") } != false) throw Exception("В архиве нет модели голоса")
                File(d, ".ok").writeText(p.model)
                progress = 100
                state = "ready"
            } catch (e: Exception) {
                error = e.message ?: e.toString()
                state = "error"
            } finally {
                tmp.delete()
            }
        }.start()
    }

    private fun engine(ctx: Context, p: Preset): OfflineTts {
        val existing = tts
        if (existing != null && ttsModel == p.model + p.pitch) return existing
        existing?.release()
        val d = dir(ctx, p.model)
        val onnx = d.listFiles()?.firstOrNull { it.name.endsWith(".onnx") } ?: throw Exception("Голос не скачан")
        val cfg = OfflineTtsConfig(
            model = OfflineTtsModelConfig(
                vits = OfflineTtsVitsModelConfig(
                    model = onnx.path,
                    tokens = File(d, "tokens.txt").path,
                    dataDir = File(d, "espeak-ng-data").path,
                    noiseScale = p.noise,
                    noiseScaleW = 0.8f,
                    lengthScale = p.pitch,
                ),
                numThreads = 2,
                debug = false,
                provider = "cpu",
            ),
            maxNumSentences = 1,
        )
        val t = OfflineTts(config = cfg)
        tts = t
        ttsModel = p.model + p.pitch
        return t
    }

    /** Разбить на фразы: первая звучит почти сразу, следующие синтезируются, пока играет предыдущая. */
    private fun sentences(text: String): List<String> {
        val parts = Regex("(?<=[.!?…;:])\\s+").split(text.trim()).flatMap { s ->
            if (s.length <= 220) listOf(s) else s.chunked(200)
        }
        return parts.map { it.trim() }.filter { it.isNotEmpty() }
    }

    /**
     * Произнести текст. Блокирует вызывающий поток до конца речи (вызывать не из UI-потока).
     * Возвращает false, если голос не готов (тогда используется системный синтез).
     */
    fun speak(ctx: Context, presetId: String, text: String, rate: Float = 1f): Boolean {
        val p = PRESETS[presetId] ?: PRESETS.getValue("tuk")
        if (!ready(ctx, p.model)) return false
        val id = ++speakId
        val eng = try {
            synchronized(this) { engine(ctx, p) }
        } catch (e: Exception) {
            error = e.message
            return false
        }
        val sr = eng.sampleRate()
        val playRate = (sr * p.pitch).toInt()
        val minBuf = AudioTrack.getMinBufferSize(playRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val at = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setSampleRate(playRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(minBuf, playRate * 4 / 4))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        synchronized(this) {
            track?.let { runCatching { it.pause(); it.flush(); it.release() } }
            track = at
        }
        val queue = LinkedBlockingQueue<FloatArray>()
        val END = FloatArray(0)
        // синтез фраз в отдельном потоке
        Thread {
            try {
                for (s in sentences(text)) {
                    if (speakId != id) break
                    val audio = synchronized(this) { eng.generate(s, 0, rate) }
                    queue.put(shape(audio.samples))
                }
            } catch (e: Exception) {
                error = e.message
            } finally {
                queue.put(END)
            }
        }.start()
        var frames = 0L
        try {
            at.play()
            while (speakId == id) {
                val chunk = queue.take()
                if (chunk === END) break
                at.write(chunk, 0, chunk.size, AudioTrack.WRITE_BLOCKING)
                frames += chunk.size
            }
            // дождаться, пока доиграет буфер
            val deadline = System.currentTimeMillis() + 3000 + frames * 1000 / playRate
            while (speakId == id && at.playbackHeadPosition < frames && System.currentTimeMillis() < deadline) Thread.sleep(30)
        } catch (_: Exception) {
        } finally {
            runCatching { at.stop() }
            synchronized(this) {
                runCatching { at.release() }
                if (track === at) track = null
            }
        }
        return true
    }

    /** Мягкий вход/выход и небольшая пауза между фразами — звучит естественнее. */
    private fun shape(s: FloatArray): FloatArray {
        val fade = minOf(220, s.size / 4)
        for (i in 0 until fade) {
            val k = i / fade.toFloat()
            s[i] *= k
            s[s.size - 1 - i] *= k
        }
        // лёгкое усиление: Piper звучит тихо по сравнению с системным голосом
        var peak = 0f
        for (v in s) if (kotlin.math.abs(v) > peak) peak = kotlin.math.abs(v)
        val g = if (peak > 0.01f) minOf(1.6f, 0.92f / peak) else 1f
        val gap = 1400
        val out = FloatArray(s.size + gap)
        for (i in s.indices) out[i] = s[i] * g
        return out
    }

    fun stop() {
        speakId++
        synchronized(this) { track?.let { runCatching { it.pause(); it.flush() } } }
    }
}
