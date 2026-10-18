package ru.tuk.plugin

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * «Тук Тук»: офлайн-распознавание (Vosk, малая русская модель) слушает постоянно.
 * Услышал «тук тук» — пискнул, настроение «слушает», ждёт команду до 8 секунд
 * (или берёт её из той же фразы: «тук тук напомни через час…») и передаёт приложению.
 */
class Wake(private val ctx: Context, private val host: IslandService) : RecognitionListener {
    companion object {
        const val URL_MODEL = "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip"
        private val WAKE = Regex("(?:^|\\s)(?:тук|тут|тюк)[\\s-]+(?:тук|тут|тюк)(?:\\s|$)")

        @Volatile var modelState: String = "none" // none | downloading | ready | error
        @Volatile var progress: Int = 0
        @Volatile var error: String? = null

        fun modelDir(ctx: Context) = File(ctx.filesDir, "vosk-ru")
        fun modelReady(ctx: Context): Boolean = File(modelDir(ctx), ".ok").exists()

        fun status(ctx: Context): String {
            if (modelState != "downloading" && modelReady(ctx)) modelState = "ready"
            return modelState
        }

        /** Скачать и распаковать модель (~45 МБ) в фоне. */
        fun download(ctx: Context) {
            if (modelState == "downloading") return
            modelState = "downloading"
            progress = 0
            error = null
            Thread {
                val tmp = File(ctx.cacheDir, "vosk-ru.zip")
                try {
                    val c = URL(URL_MODEL).openConnection() as HttpURLConnection
                    c.connectTimeout = 15000
                    c.readTimeout = 30000
                    c.instanceFollowRedirects = true
                    val total = c.contentLengthLong.takeIf { it > 0 } ?: 46_000_000L
                    c.inputStream.use { inp ->
                        FileOutputStream(tmp).use { out ->
                            val buf = ByteArray(64 * 1024)
                            var got = 0L
                            while (true) {
                                val n = inp.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                got += n
                                progress = ((got * 90) / total).toInt().coerceAtMost(90)
                            }
                        }
                    }
                    val dir = modelDir(ctx)
                    dir.deleteRecursively()
                    dir.mkdirs()
                    ZipInputStream(tmp.inputStream().buffered()).use { zip ->
                        while (true) {
                            val e = zip.nextEntry ?: break
                            // архив содержит папку vosk-model-small-ru-0.22/ — убираем её из пути
                            val rel = e.name.substringAfter('/', "")
                            if (rel.isEmpty() || rel.contains("..")) continue
                            val f = File(dir, rel)
                            if (e.isDirectory) f.mkdirs() else {
                                f.parentFile?.mkdirs()
                                FileOutputStream(f).use { zip.copyTo(it) }
                            }
                        }
                    }
                    File(dir, ".ok").writeText("vosk-model-small-ru-0.22")
                    progress = 100
                    modelState = "ready"
                } catch (e: Exception) {
                    error = e.message ?: e.toString()
                    modelState = "error"
                } finally {
                    tmp.delete()
                }
            }.start()
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var model: Model? = null
    private var rec: Recognizer? = null
    private var speech: SpeechService? = null
    @Volatile private var state = "off" // off | loading | wait | command | paused
    private var commandUntil = 0L
    private var paused = false

    fun start() {
        if (state != "off") return
        state = "loading"
        Thread {
            try {
                val m = Model(modelDir(ctx).absolutePath)
                main.post {
                    model = m
                    if (state == "loading") listen()
                    else m.close()
                }
            } catch (e: Exception) {
                error = e.message
                state = "off"
            }
        }.start()
    }

    private fun listen() {
        val m = model ?: return
        if (paused) {
            state = "paused"
            return
        }
        try {
            val r = Recognizer(m, 16000f)
            rec = r
            val sp = SpeechService(r, 16000f)
            speech = sp
            sp.startListening(this)
            state = "wait"
        } catch (e: Exception) {
            error = e.message
            state = "off"
            main.postDelayed({ if (state == "off" && model != null) listen() }, 5000)
        }
    }

    private fun closeAudio() {
        runCatching { speech?.stop() }
        runCatching { speech?.shutdown() }
        speech = null
        runCatching { rec?.close() }
        rec = null
    }

    fun stop() {
        state = "off"
        closeAudio()
        runCatching { model?.close() }
        model = null
        Island.wakeMood = null
        Island.wakeText = null
        Island.refresh()
    }

    /** Микрофон нужен приложению (кнопка 🎤) — освобождаем. */
    fun pause() {
        val run = Runnable {
            paused = true
            closeAudio()
            if (state != "off") state = "paused"
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run() else main.post(run)
    }

    fun resume() {
        main.post {
            paused = false
            if (model != null && speech == null && state != "off") listen()
        }
    }

    private fun text(json: String?, key: String): String =
        runCatching { JSONObject(json ?: "{}").optString(key, "") }.getOrDefault("").lowercase().trim()

    private fun afterWake(t: String): String {
        val m = WAKE.find(" $t ") ?: return t
        return (" $t ").substring(m.range.last + 1).trim()
    }

    private fun beep() {
        runCatching { ToneGenerator(AudioManager.STREAM_MUSIC, 70).startTone(ToneGenerator.TONE_PROP_ACK, 160) }
        runCatching {
            val v = ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(40, VibrationEffect.DEFAULT_AMPLITUDE))
            else @Suppress("DEPRECATION") v.vibrate(40)
        }
    }

    private fun enterCommand() {
        state = "command"
        commandUntil = System.currentTimeMillis() + 8000
        beep()
        Island.wakeMood = "listen"
        Island.wakeText = "Слушаю…"
        Island.refresh()
        main.postDelayed({
            if (state == "command" && System.currentTimeMillis() >= commandUntil) {
                state = "wait"
                Island.wakeMood = null
                Island.wakeText = null
                Island.refresh()
            }
        }, 8200)
    }

    private fun deliver(cmd: String) {
        state = "wait"
        Island.wakeMood = "think"
        Island.wakeText = cmd
        Island.refresh()
        host.openApp(true, cmd)
        main.postDelayed({
            Island.wakeMood = null
            Island.wakeText = null
            Island.refresh()
        }, 2500)
    }

    override fun onPartialResult(hypothesis: String?) {
        val t = text(hypothesis, "partial")
        if (t.isEmpty()) return
        main.post {
            if (state == "wait" && WAKE.containsMatchIn(" $t ")) enterCommand()
            else if (state == "command") {
                val rest = afterWake(t)
                if (rest.isNotEmpty()) {
                    Island.wakeText = rest
                    commandUntil = System.currentTimeMillis() + 4000
                    Island.refresh()
                }
            }
        }
    }

    override fun onResult(hypothesis: String?) {
        val t = text(hypothesis, "text")
        main.post { handleFinal(t) }
    }

    override fun onFinalResult(hypothesis: String?) {
        val t = text(hypothesis, "text")
        main.post { handleFinal(t) }
    }

    private fun handleFinal(t: String) {
        when (state) {
            "wait" -> if (WAKE.containsMatchIn(" $t ")) {
                val rest = afterWake(t)
                if (rest.split(' ').size >= 1 && rest.length > 2) {
                    beep()
                    deliver(rest)
                } else enterCommand()
            }
            "command" -> {
                val rest = afterWake(t)
                if (rest.length > 1) deliver(rest)
            }
        }
    }

    override fun onError(exception: Exception?) {
        error = exception?.message
        main.post {
            closeAudio()
            if (state != "off") main.postDelayed({ if (state != "off" && !paused) listen() }, 1500)
        }
    }

    override fun onTimeout() {}
}
