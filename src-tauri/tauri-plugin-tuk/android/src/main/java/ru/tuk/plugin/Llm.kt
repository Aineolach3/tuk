package ru.tuk.plugin

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

/**
 * Мозг Тука на Android: llama.cpp нативно (libtukllm.so).
 * Модель скачивается в файлы приложения и читается через mmap — без копирования в память WebView.
 * JS опрашивает состояние (poll), поэтому никаких событий и каналов не нужно.
 */
object Llm {
    interface TokenSink {
        fun onToken(b: ByteArray): Boolean
    }

    private var libOk: Boolean? = null
    private fun lib(): Boolean {
        libOk?.let { return it }
        val ok = try {
            System.loadLibrary("tukllm")
            true
        } catch (e: Throwable) {
            error = "Мозг не встроен в эту сборку: ${e.message}"
            false
        }
        libOk = ok
        return ok
    }

    external fun nativeLoad(path: String, nCtx: Int, nThreads: Int): Boolean
    external fun nativeChat(roles: Array<String>, contents: Array<ByteArray>, maxTokens: Int, temp: Float, topP: Float, topK: Int, sink: TokenSink): Int
    external fun nativeStop()
    external fun nativeUnload()

    // ---------- состояние для JS ----------
    @Volatile var state: String = "idle" // idle | downloading | loading | ready | error
    @Volatile var progress: Long = 0
    @Volatile var total: Long = 0
    @Volatile var error: String? = null
    @Volatile var loadedPath: String? = null

    // текущий ответ
    @Volatile var genId: Int = 0
    private val answer = StringBuilder()
    @Volatile var genDone: Boolean = true
    @Volatile var genError: String? = null
    @Volatile private var cancelDownload = false

    fun dir(ctx: Context) = File(ctx.filesDir, "models").apply { mkdirs() }
    fun file(ctx: Context, name: String) = File(dir(ctx), name)

    fun exists(ctx: Context, name: String): Boolean = file(ctx, name).let { it.exists() && !File(it.path + ".part").exists() && it.length() > 1_000_000 }

    /** Скачать модель с докачкой (.part). */
    fun download(ctx: Context, url: String, name: String, expected: Long) {
        if (state == "downloading") return
        state = "downloading"
        error = null
        cancelDownload = false
        Thread {
            val dst = file(ctx, name)
            val part = File(dst.path + ".part")
            try {
                var have = if (part.exists()) part.length() else 0L
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 20000
                c.readTimeout = 60000
                c.instanceFollowRedirects = true
                if (have > 0) c.setRequestProperty("Range", "bytes=$have-")
                val code = c.responseCode
                if (code == 200) have = 0 // сервер не поддержал докачку — начинаем сначала
                else if (code != 206) throw Exception("Сервер ответил $code")
                val len = c.contentLengthLong
                total = if (len > 0) have + len else expected
                progress = have
                RandomAccessFile(part, "rw").use { out ->
                    out.seek(have)
                    c.inputStream.use { inp ->
                        val buf = ByteArray(256 * 1024)
                        while (true) {
                            if (cancelDownload) throw Exception("Загрузка остановлена")
                            val n = inp.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            progress += n
                        }
                    }
                }
                if (dst.exists()) dst.delete()
                if (!part.renameTo(dst)) throw Exception("Не удалось сохранить модель")
                state = "idle"
            } catch (e: Exception) {
                error = humanize(e)
                state = "error"
            }
        }.start()
    }

    fun cancel() {
        cancelDownload = true
    }

    private fun humanize(e: Exception): String {
        val m = e.message ?: e.toString()
        return when {
            e is java.net.UnknownHostException || m.contains("Unable to resolve") -> "Нет интернета. Подключитесь к Wi-Fi и нажмите «Скачать» ещё раз — загрузка продолжится."
            m.contains("ENOSPC") || m.contains("No space") -> "Не хватает места на телефоне для модели."
            else -> m
        }
    }

    fun threads(): Int = (Runtime.getRuntime().availableProcessors() - 2).coerceIn(2, 5)

    /** Загрузить модель в фоне. */
    fun load(ctx: Context, name: String, nCtx: Int) {
        if (state == "loading") return
        if (!lib()) {
            state = "error"
            return
        }
        val f = file(ctx, name)
        if (loadedPath == f.path && state == "ready") return
        state = "loading"
        error = null
        Thread {
            try {
                val ok = nativeLoad(f.path, nCtx, threads())
                if (ok) {
                    loadedPath = f.path
                    state = "ready"
                } else {
                    loadedPath = null
                    error = "Не удалось загрузить модель. Возможно, файл повреждён — удалите мозг и скачайте заново."
                    state = "error"
                }
            } catch (e: Throwable) {
                error = e.message ?: e.toString()
                state = "error"
            }
        }.start()
    }

    fun unload() {
        if (libOk == true) runCatching { nativeUnload() }
        loadedPath = null
        state = "idle"
    }

    fun delete(ctx: Context, name: String) {
        unload()
        file(ctx, name).delete()
        File(file(ctx, name).path + ".part").delete()
    }

    /** Начать ответ. Возвращает id; текст забирается через poll(). */
    @Synchronized
    fun chat(roles: Array<String>, contents: Array<String>, maxTokens: Int, temp: Float, topP: Float, topK: Int): Int {
        val id = ++genId
        synchronized(answer) { answer.setLength(0) }
        genDone = false
        genError = null
        val bytes = contents.map { it.toByteArray(Charsets.UTF_8) }.toTypedArray()
        Thread {
            try {
                val sink = object : TokenSink {
                    override fun onToken(b: ByteArray): Boolean {
                        if (genId != id) return false
                        synchronized(answer) { answer.append(String(b, Charsets.UTF_8)) }
                        return true
                    }
                }
                val n = nativeChat(roles, bytes, maxTokens, temp, topP, topK, sink)
                if (n < 0 && genId == id) genError = "Мозг не смог ответить (код $n)"
            } catch (e: Throwable) {
                if (genId == id) genError = e.message ?: e.toString()
            } finally {
                if (genId == id) genDone = true
            }
        }.start()
        return id
    }

    fun text(): String = synchronized(answer) { answer.toString() }

    fun stop() {
        if (libOk == true) runCatching { nativeStop() }
    }
}
