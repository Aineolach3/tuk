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
    /** Живой голос: tuk | bright | boy | calm; пусто — системный синтез. */
    var voice: String? = null
}

@InvokeArg
class VoiceArgs {
    var action: String = "status"
    var voice: String = "tuk"
}

@InvokeArg
class LlmArgs {
    var action: String = "status"
    var name: String? = null
    var url: String? = null
    var bytes: Long? = null
    var ctx: Int? = null
    var roles: List<String>? = null
    var contents: List<String>? = null
    var maxTokens: Int? = null
    var temp: Float? = null
    var topP: Float? = null
    var topK: Int? = null
    var id: Int? = null
}

@InvokeArg
class ActArgs {
    var action: String = ""
    var hour: Int? = null
    var minute: Int? = null
    var days: List<Int>? = null
    var label: String? = null
    var seconds: Int? = null
    var number: String? = null
    var text: String? = null
    var pkg: String? = null
    var url: String? = null
    var on: Boolean? = null
    var dir: String? = null
    var key: String? = null
    var place: String? = null
    var query: String? = null
    var title: String? = null
    var begin: Long? = null
    var end: Long? = null
    var which: String? = null
    var op: String? = null
    var mode: String? = null
    var lock: Boolean? = null
}

@TauriPlugin
class TukPlugin(private val activity: Activity) : Plugin(activity) {

    override fun load(webView: WebView) {
        super.load(webView)
        // прозрачный фон: в режиме выпадающего окна под ним видно приложение, из которого нажали на остров
        webView.setBackgroundColor(Color.TRANSPARENT)
        if (activity.intent?.getBooleanExtra("tuk_drop", false) == true) Island.drop = true
        // без MulticastLock часть прошивок отбрасывает входящие UDP-broadcast («Кто рядом», поиск ПК)
        try {
            val wifi = activity.applicationContext.getSystemService(android.content.Context.WIFI_SERVICE) as android.net.wifi.WifiManager
            multicastLock = wifi.createMulticastLock("tuk-nearby").apply { setReferenceCounted(false); acquire() }
        } catch (_: Exception) {}
    }

    private var multicastLock: android.net.wifi.WifiManager.MulticastLock? = null

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
            "look" -> {
                // наряд и цвета для живого Тука на острове (JSON {outfit, hood, light})
                a.data?.let { Island.setLook(activity, it) }
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
            Voice.stop()
            invoke.resolve()
            return
        }
        val text = a.text ?: ""
        if (text.isBlank()) {
            invoke.resolve()
            return
        }
        val preset = a.voice
        if (!preset.isNullOrEmpty() && Voice.ready(activity, (Voice.PRESETS[preset] ?: Voice.PRESETS.getValue("tuk")).model)) {
            tts?.stop()
            Thread {
                val ok = runCatching { Voice.speak(activity, preset, text, a.rate ?: 1f) }.getOrDefault(false)
                if (ok) invoke.resolve()
                else activity.runOnUiThread { speakSystem(text, a.rate, invoke) }
            }.start()
            return
        }
        speakSystem(text, a.rate, invoke)
    }

    private fun speakSystem(text: String, rate: Float?, invoke: Invoke) {
        ensureTts()
        rate?.let { tts?.setSpeechRate(it) }
        if (ttsReady) say(text, invoke) else {
            queued?.second?.resolve()
            queued = text to invoke
        }
    }

    // ---------------- Живой голос ----------------

    @Command
    fun voice(invoke: Invoke) {
        val a = invoke.parseArgs(VoiceArgs::class.java)
        val r = JSObject()
        when (a.action) {
            "download" -> Voice.download(activity, a.voice)
            "status" -> {}
        }
        r.put("state", Voice.status(activity, a.voice))
        r.put("progress", Voice.progress)
        Voice.error?.let { r.put("error", it) }
        invoke.resolve(r)
    }

    // ---------------- Мозг (llama.cpp) ----------------

    @Command
    fun llm(invoke: Invoke) {
        val a = invoke.parseArgs(LlmArgs::class.java)
        val r = JSObject()
        try {
            when (a.action) {
                "status" -> {
                    a.name?.let { r.put("exists", Llm.exists(activity, it)) }
                }
                "download" -> Llm.download(activity, a.url ?: throw Exception("нет адреса"), a.name ?: throw Exception("нет имени"), a.bytes ?: 0L)
                "cancel" -> Llm.cancel()
                "load" -> Llm.load(activity, a.name ?: throw Exception("нет имени"), a.ctx ?: 3072)
                "unload" -> Llm.unload()
                "delete" -> Llm.delete(activity, a.name ?: throw Exception("нет имени"))
                "chat" -> {
                    val roles = (a.roles ?: emptyList()).toTypedArray()
                    val contents = (a.contents ?: emptyList()).toTypedArray()
                    r.put("id", Llm.chat(roles, contents, a.maxTokens ?: 400, a.temp ?: 0.7f, a.topP ?: 0.9f, a.topK ?: 40))
                }
                "poll" -> {
                    r.put("text", Llm.text())
                    r.put("done", Llm.genDone || (a.id != null && a.id != Llm.genId))
                    Llm.genError?.let { r.put("error", it) }
                }
                "stop" -> Llm.stop()
            }
            r.put("state", Llm.state)
            r.put("progress", Llm.progress)
            r.put("total", Llm.total)
            Llm.error?.let { r.put("error", it) }
            invoke.resolve(r)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    // ---------------- Действия ----------------

    private val actions by lazy { Actions(activity) }

    @Command
    fun act(invoke: Invoke) {
        val a = invoke.parseArgs(ActArgs::class.java)
        val r = JSObject()
        try {
            when (a.action) {
                "perm" -> r.put("granted", actions.hasPermission(a.which ?: ""))
                "ask" -> actions.request(a.which ?: "")
                "alarm" -> actions.alarm(a.hour ?: 7, a.minute ?: 0, a.label, a.days)
                "timer" -> actions.timer(a.seconds ?: 60, a.label)
                "contacts" -> r.put("list", actions.contacts())
                "call" -> r.put("direct", actions.call(a.number ?: throw Exception("Нет номера")))
                "sms" -> actions.sms(a.number ?: throw Exception("Нет номера"), a.text ?: "")
                "apps" -> r.put("list", actions.apps())
                "open" -> actions.open(a.pkg ?: throw Exception("Нет приложения"))
                "url" -> actions.url(a.url ?: throw Exception("Нет адреса"))
                "torch" -> actions.torch(a.on ?: true)
                "volume" -> r.put("level", actions.volume(a.dir ?: "up"))
                "media" -> actions.media(a.key ?: "toggle")
                "navigate" -> actions.navigate(a.place ?: "")
                "search" -> actions.search(a.query ?: "")
                "battery" -> {
                    val b = actions.battery()
                    r.put("level", b.getInt("level"))
                    r.put("charging", b.getBoolean("charging"))
                }
                "calendar" -> actions.calendar(a.title ?: "Событие", a.begin ?: System.currentTimeMillis(), a.end ?: ((a.begin ?: System.currentTimeMillis()) + 3_600_000))
                "camera" -> actions.camera()
                "settings" -> actions.settings(a.which ?: "main")
                "alarmControl" -> actions.alarmControl(a.op ?: "showAlarms")
                "dnd" -> {
                    if (!actions.canDnd()) {
                        actions.askDnd()
                        r.put("needPerm", "dnd")
                    } else r.put("ok", actions.dnd(a.on ?: true))
                }
                "ringer" -> {
                    if (!actions.ringer(a.mode ?: "normal")) {
                        actions.askDnd()
                        r.put("needPerm", "dnd")
                    } else r.put("ok", true)
                }
                "brightness" -> {
                    if (!actions.canWriteSystem()) {
                        actions.askWriteSystem()
                        r.put("needPerm", "write")
                    } else r.put("level", actions.brightness(a.dir ?: "up"))
                }
                "rotate" -> {
                    if (!actions.canWriteSystem()) {
                        actions.askWriteSystem()
                        r.put("needPerm", "write")
                    } else r.put("ok", actions.rotate(a.lock ?: false))
                }
                "canSystem" -> {
                    r.put("dnd", actions.canDnd())
                    r.put("write", actions.canWriteSystem())
                }
                else -> throw Exception("Неизвестное действие ${a.action}")
            }
            invoke.resolve(r)
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }
}
