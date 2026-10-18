package ru.tuk.plugin

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.Locale

@InvokeArg
class IslandArgs {
    var action: String = "check"
    var mood: String? = null
    var text: String? = null
    var badge: Int? = null
    var data: String? = null
    var frames: Int? = null
    var fps: Int? = null
    var show: Boolean? = null
    var wake: Boolean? = null
}

@InvokeArg
class ListenArgs {
    var action: String = "start"
}

@InvokeArg
class SpeakArgs {
    var text: String? = null
    var stop: Boolean? = null
    var rate: Float? = null
}

@TauriPlugin
class TukPlugin(private val activity: Activity) : Plugin(activity) {

    override fun load(webView: WebView) {
        super.load(webView)
        // прозрачный фон: в режиме выпадающего окна под ним видно приложение, из которого нажали на остров
        webView.setBackgroundColor(Color.TRANSPARENT)
        if (activity.intent?.getBooleanExtra("tuk_drop", false) == true) Island.drop = true
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra("tuk_drop", false)) Island.drop = true
    }

    override fun onResume() {
        super.onResume()
        Island.appVisible = true
        Island.refresh()
    }

    override fun onPause() {
        super.onPause()
        Island.appVisible = false
        Island.refresh()
    }

    // ---------------- Остров ----------------

    private fun micGranted(): Boolean =
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4712)
        }
    }

    private fun canDraw(): Boolean = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(activity)

    @Command
    fun island(invoke: Invoke) {
        val a = invoke.parseArgs(IslandArgs::class.java)
        val r = JSObject()
        when (a.action) {
            "check" -> {
                r.put("granted", canDraw())
                r.put("running", Island.service != null)
                r.put("mic", micGranted())
                r.put("model", Wake.status(activity))
                r.put("progress", Wake.progress)
                Wake.error?.let { r.put("error", it) }
            }
            "download" -> Wake.download(activity)
            "config" -> {
                val show = a.show ?: true
                val wake = a.wake ?: false
                if (!show && !wake) {
                    activity.stopService(Intent(activity, IslandService::class.java))
                } else {
                    if (!canDraw()) {
                        invoke.reject("Нет разрешения «Поверх других приложений»")
                        return
                    }
                    if (wake && !micGranted()) {
                        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.RECORD_AUDIO), 4711)
                        invoke.reject("Разрешите доступ к микрофону и включите ещё раз")
                        return
                    }
                    askNotifications()
                    val i = Intent(activity, IslandService::class.java).putExtra("show", show).putExtra("wake", wake)
                    ContextCompat.startForegroundService(activity, i)
                }
            }
            "grant" -> {
                val i = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + activity.packageName))
                runCatching { activity.startActivity(i) }
                    .onFailure { activity.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)) }
            }
            "start" -> {
                if (!canDraw()) {
                    invoke.reject("Нет разрешения «Поверх других приложений»")
                    return
                }
                askNotifications()
                ContextCompat.startForegroundService(activity, Intent(activity, IslandService::class.java))
            }
            "stop" -> activity.stopService(Intent(activity, IslandService::class.java))
            "update" -> {
                a.mood?.let { Island.mood = it }
                a.text?.let { Island.text = it }
                a.badge?.let { Island.badge = it }
                Island.refresh()
            }
            "sprite" -> {
                val m = a.mood
                val d = a.data
                if (m == null || d == null) {
                    invoke.reject("Нет кадров")
                    return
                }
                Island.saveSprite(activity, m, d, a.frames ?: 1, a.fps ?: 8)
            }
            "consume" -> {
                r.put("drop", Island.drop)
                Island.cmd?.let { r.put("cmd", it) }
                Island.drop = false
                Island.cmd = null
            }
            "back" -> activity.moveTaskToBack(true)
        }
        invoke.resolve(r)
    }

    // ---------------- Распознавание речи ----------------

    private var recognizer: SpeechRecognizer? = null
    private var partial: String = ""
    private var listening = false
    private var pending: Invoke? = null
    private var triedOnDevice = false

    private fun errText(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Не расслышал"
        SpeechRecognizer.ERROR_AUDIO -> "Микрофон занят"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Нет доступа к микрофону"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER ->
            "Нужен интернет или офлайн-пакет русского языка (Настройки → Общие → Язык и ввод → Распознавание речи)"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Распознавание занято, попробуйте ещё раз"
        12, 13 -> "Нет офлайн-пакета русского языка"
        else -> "Ошибка распознавания ($code)"
    }

    private fun finish(text: String?, error: String?) {
        if (listening) Island.service?.wake?.resume()
        listening = false
        val inv = pending
        pending = null
        recognizer?.destroy()
        recognizer = null
        if (inv == null) return
        if (error != null) inv.reject(error)
        else inv.resolve(JSObject().apply { put("text", text ?: "") })
    }

    private fun startRecognizer(onDevice: Boolean) {
        val rec = if (onDevice && Build.VERSION.SDK_INT >= 31) SpeechRecognizer.createOnDeviceSpeechRecognizer(activity)
        else SpeechRecognizer.createSpeechRecognizer(activity)
        recognizer = rec
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(b: Bundle?) {
                b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { partial = it }
            }
            override fun onResults(b: Bundle?) {
                val t = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: partial
                finish(t, null)
            }
            override fun onError(error: Int) {
                // офлайн-распознаватель без русского — пробуем обычный с предпочтением офлайна
                if (onDevice && (error == 12 || error == 13 || error == SpeechRecognizer.ERROR_CLIENT)) {
                    rec.destroy()
                    startRecognizer(false)
                    return
                }
                if ((error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) && partial.isNotEmpty()) {
                    finish(partial, null)
                } else {
                    finish(null, errText(error))
                }
            }
        })
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "ru-RU")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        rec.startListening(i)
    }

    @Command
    fun listen(invoke: Invoke) {
        val a = invoke.parseArgs(ListenArgs::class.java)
        when (a.action) {
            "partial" -> {
                invoke.resolve(JSObject().apply { put("text", partial); put("listening", listening) })
                return
            }
            "stop" -> {
                activity.runOnUiThread { recognizer?.stopListening() }
                invoke.resolve()
                return
            }
            "cancel" -> {
                activity.runOnUiThread { finish(null, "Отменено") }
                invoke.resolve()
                return
            }
        }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.RECORD_AUDIO), 4711)
            invoke.reject("Разрешите доступ к микрофону и нажмите ещё раз")
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            invoke.reject("На телефоне нет службы распознавания речи")
            return
        }
        activity.runOnUiThread {
            if (listening) finish(null, "Отменено")
            partial = ""
            Island.service?.wake?.pause()
            listening = true
            pending = invoke
            val onDevice = Build.VERSION.SDK_INT >= 31 && runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(activity) }.getOrDefault(false)
            triedOnDevice = onDevice
            startRecognizer(onDevice)
        }
    }

    // ---------------- Синтез речи ----------------

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val waiting = HashMap<String, Invoke>()
    private var queued: Pair<String, Invoke>? = null
    private var seq = 0

    private fun ensureTts() {
        if (tts != null) return
        tts = TextToSpeech(activity) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                tts?.language = Locale("ru", "RU")
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(id: String?) {}
                    override fun onDone(id: String?) {
                        id?.let { waiting.remove(it)?.resolve() }
                    }
                    @Deprecated("Deprecated in Java")
                    override fun onError(id: String?) {
                        id?.let { waiting.remove(it)?.reject("Ошибка синтеза речи") }
                    }
                    override fun onStop(id: String?, interrupted: Boolean) {
                        id?.let { waiting.remove(it)?.resolve() }
                    }
                })
                queued?.let { (t, inv) -> say(t, inv) }
            } else {
                queued?.second?.reject("Синтез речи недоступен")
            }
            queued = null
        }
    }

    private fun say(text: String, inv: Invoke) {
        val id = "tuk" + (++seq)
        waiting[id] = inv
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
    }

    @Command
    fun speak(invoke: Invoke) {
        val a = invoke.parseArgs(SpeakArgs::class.java)
        if (a.stop == true) {
            tts?.stop()
            invoke.resolve()
            return
        }
        val text = a.text ?: ""
        if (text.isBlank()) {
            invoke.resolve()
            return
        }
        ensureTts()
        a.rate?.let { tts?.setSpeechRate(it) }
        if (ttsReady) say(text, invoke) else {
            queued?.second?.resolve()
            queued = text to invoke
        }
    }
}
