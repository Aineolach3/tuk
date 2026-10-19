package ru.tuk.plugin

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.text.TextPaint
import android.text.TextUtils
import android.util.Base64
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File

/** Общее состояние: его меняют плагин (из JS), остров и распознаватель «Тук Тук». */
object Island {
    @Volatile var mood: String = "idle"
    @Volatile var text: String = ""
    @Volatile var badge: Int = 0
    /** Приложение открыто с острова — показать выпадающее окно. */
    @Volatile var drop: Boolean = false
    /** Команда, сказанная после «Тук Тук», — её выполнит приложение. */
    @Volatile var cmd: String? = null
    /** Приложение на экране — остров прячется. */
    @Volatile var appVisible: Boolean = false
    /** Пока Тук сам слушает «Тук Тук» и команду, его настроение задаёт распознаватель. */
    @Volatile var wakeMood: String? = null
    @Volatile var wakeText: String? = null
    /** Наряд и цвета Тука (JSON {outfit, hood, light}) — для живого Тука в WebView. */
    @Volatile var look: String? = null
    var service: IslandService? = null

    fun spriteDir(ctx: Context): File = File(ctx.filesDir, "island").apply { mkdirs() }

    fun saveSprite(ctx: Context, mood: String, b64: String, frames: Int, fps: Int) {
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        File(spriteDir(ctx), "$mood.png").writeBytes(bytes)
        File(spriteDir(ctx), "$mood.meta").writeText("$frames,$fps")
        service?.reloadSprite(mood)
    }

    fun setLook(ctx: Context, json: String) {
        look = json
        prefs(ctx).edit().putString("look", json).apply()
        service?.reloadLook()
    }

    fun refresh() {
        service?.refresh()
    }

    fun prefs(ctx: Context) = ctx.getSharedPreferences("tuk_island", Context.MODE_PRIVATE)
}

class IslandService : Service() {
    private lateinit var wm: WindowManager
    /** Окно острова: живой Тук в WebView или, если WebView недоступен, старые кадры. */
    private var view: View? = null
    private var web: IslandWeb? = null
    private var params: WindowManager.LayoutParams? = null
    private val main = Handler(Looper.getMainLooper())
    var wake: Wake? = null
    private var show = true
    private var wakeOn = false
    /** Экран включён — без этого анимацию не крутим. */
    private var screenOn = true
    /** WebView однажды не завёлся — до перезапуска сервиса рисуем нативно. */
    private var webBroken = false
    private var lastMood = ""

    private val dp get() = resources.displayMetrics.density
    /** Размер персонажа на экране (как у прежнего острова), px. */
    private val charW get() = (IslandWeb.CHAR_W_DP * dp).toInt()
    private val charH get() = (IslandWeb.CHAR_H_DP * dp).toInt()

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
            when (i?.action) {
                Intent.ACTION_SCREEN_OFF -> screenOn = false
                Intent.ACTION_SCREEN_ON -> screenOn = true
                else -> return
            }
            refresh()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Island.service = this
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val p = Island.prefs(this)
        show = p.getBoolean("show", true)
        wakeOn = p.getBoolean("wake", false)
        if (Island.look == null) Island.look = p.getString("look", null)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        screenOn = pm.isInteractive
        val f = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        // системные широковещательные доходят и до неэкспортированного приёмника
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, f, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(screenReceiver, f)
        startAsForeground()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent != null && intent.hasExtra("show")) {
            show = intent.getBooleanExtra("show", true)
            wakeOn = intent.getBooleanExtra("wake", false)
            Island.prefs(this).edit().putBoolean("show", show).putBoolean("wake", wakeOn).apply()
            startAsForeground()
        }
        apply()
        return START_STICKY
    }

    override fun onDestroy() {
        Island.service = null
        runCatching { unregisterReceiver(screenReceiver) }
        main.removeCallbacksAndMessages(null)
        wake?.stop()
        wake = null
        removeView()
        super.onDestroy()
    }

    private fun micGranted() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private var micForeground = false

    private fun startAsForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel("tuk_island", "Тук рядом", NotificationManager.IMPORTANCE_MIN)
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
        val open = PendingIntent.getActivity(
            this, 1, launchIntent(false),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "tuk_island") else Notification.Builder(this)
        val n = b.setContentTitle("Тук рядом")
            .setContentText(if (wakeOn) "Скажите «Тук Тук» — и команду" else "Нажмите на Тука вверху экрана")
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        val wantMic = wakeOn && micGranted()
        micForeground = false
        try {
            when {
                Build.VERSION.SDK_INT >= 34 -> startForeground(
                    7101, n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or (if (wantMic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
                )
                Build.VERSION.SDK_INT >= 30 && wantMic -> startForeground(7101, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                else -> startForeground(7101, n)
            }
            micForeground = wantMic
        } catch (e: Exception) {
            // микрофон в фоне можно включить, только пока приложение на экране — без него остров всё равно работает
            if (Build.VERSION.SDK_INT >= 34) startForeground(7101, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(7101, n)
        }
    }

    private fun apply() {
        if (show && view == null) addView()
        if (!show && view != null) removeView()
        val canWake = wakeOn && micForeground && Wake.modelReady(this)
        if (canWake && wake == null) {
            wake = Wake(this, this).also { it.start() }
        } else if (!canWake && wake != null) {
            wake?.stop()
            wake = null
            Island.wakeMood = null
            Island.wakeText = null
        }
        refresh()
    }

    fun launchIntent(drop: Boolean): Intent {
        val i = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        i.putExtra("tuk_drop", drop)
        return i
    }

    fun openApp(drop: Boolean, cmd: String? = null) {
        Island.drop = drop
        if (cmd != null) Island.cmd = cmd
        runCatching { startActivity(launchIntent(drop)) }
    }

    private fun removeView() {
        view?.let { runCatching { wm.removeView(it) } }
        web?.destroy()
        web = null
        view = null
    }

    /** Живой Тук возможен: страница острова лежит в assets и WebView ещё не падал. */
    private fun webPossible(): Boolean =
        !webBroken && runCatching { assets.list("island")?.contains("island-android.html") == true }.getOrDefault(false)

    @SuppressLint("ClickableViewAccessibility")
    private fun addView() {
        // живой Тук в прозрачном WebView; если WebView не создаётся (нет/обновляется провайдер) — старые кадры
        var w: IslandWeb? = null
        if (webPossible()) {
            w = runCatching { IslandWeb(this, ::onWebWidth, ::onWebFailed) }.getOrNull()
            if (w == null) webBroken = true
        }
        val v: View = w?.view ?: IslandView(this)
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        val p = WindowManager.LayoutParams(
            // окно ровно по персонажу; облачко расширяет его вправо (onWebWidth)
            if (w != null) charW else WindowManager.LayoutParams.WRAP_CONTENT,
            if (w != null) charH else WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT
        )
        p.gravity = Gravity.TOP or Gravity.START
        if (Build.VERSION.SDK_INT >= 28) {
            p.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        // место с прошлого раза или слева от камеры
        val prefs = Island.prefs(this)
        val screenW = resources.displayMetrics.widthPixels
        p.x = prefs.getInt("x", screenW / 2 - charW - (8 * dp).toInt())
        p.y = prefs.getInt("y", 0)

        var dragging = false
        val gd = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                web?.tap() ?: (view as? IslandView)?.bounce()
                openApp(true)
                return true
            }
            override fun onLongPress(e: MotionEvent) {
                if (!dragging) openApp(false)
            }
        })
        var sx = 0f
        var sy = 0f
        var px = 0
        var py = 0
        // скорость перетаскивания для «полёта» Тука, dp/с
        var lx = 0f
        var ly = 0f
        var lt = 0L
        var vx = 0f
        var vy = 0f
        var flySent = 0L
        val slop = 12 * dp
        fun cancelGesture(e: MotionEvent) {
            val cancel = MotionEvent.obtain(e)
            cancel.action = MotionEvent.ACTION_CANCEL
            gd.onTouchEvent(cancel)
            cancel.recycle()
        }
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    sx = e.rawX; sy = e.rawY; px = p.x; py = p.y
                    lx = e.rawX; ly = e.rawY; lt = e.eventTime
                    vx = 0f; vy = 0f
                    dragging = false
                    (v as? IslandView)?.dragging = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - sx
                    val dy = e.rawY - sy
                    if (!dragging && (Math.abs(dx) > slop || Math.abs(dy) > slop)) {
                        dragging = true
                        (v as? IslandView)?.dragging = true
                    }
                    if (dragging) {
                        p.x = (px + dx).toInt().coerceIn(0, (resources.displayMetrics.widthPixels - charW).coerceAtLeast(0))
                        p.y = (py + dy).toInt().coerceIn(0, (resources.displayMetrics.heightPixels - charH).coerceAtLeast(0))
                        runCatching { wm.updateViewLayout(v, p) }
                        val dtMs = (e.eventTime - lt).coerceAtLeast(1L)
                        // сглаживание: палец дёргается, а Тук должен лететь плавно
                        vx = vx * 0.6f + 0.4f * ((e.rawX - lx) / dp) * 1000f / dtMs
                        vy = vy * 0.6f + 0.4f * ((e.rawY - ly) / dp) * 1000f / dtMs
                        lx = e.rawX; ly = e.rawY; lt = e.eventTime
                        if (e.eventTime - flySent > 32) {
                            flySent = e.eventTime
                            web?.fly(vx, vy)
                        }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) {
                        prefs.edit().putInt("x", p.x).putInt("y", p.y).apply()
                        dragging = false
                        (v as? IslandView)?.dragging = false
                        web?.land()
                        cancelGesture(e)
                        return@setOnTouchListener true
                    }
                }
            }
            if (dragging) {
                cancelGesture(e)
                true
            } else {
                gd.onTouchEvent(e)
                // касания WebView не нужны: всё решает сервис
                true
            }
        }
        view = v
        web = w
        params = p
        try {
            wm.addView(v, p)
        } catch (e: Exception) {
            view = null
            web?.destroy()
            web = null
            if (w != null) {
                // окно с WebView не добавилось — пробуем нативный остров
                webBroken = true
                addView()
            }
        }
    }

    /** Страница посчитала облачко: окно = персонаж + облачко (dp → px). */
    private fun onWebWidth(cssWidth: Int) {
        main.post {
            val v = view ?: return@post
            val p = params ?: return@post
            if (web == null) return@post
            val wpx = (cssWidth.coerceIn(IslandWeb.CHAR_W_DP, IslandWeb.CHAR_W_DP + 240) * dp).toInt()
            if (p.width == wpx) return@post
            p.width = wpx
            // облачко у правого края — Тук не уезжает, окно растёт вправо, но не за экран
            runCatching { wm.updateViewLayout(v, p) }
        }
    }

    /** WebView упал или не загрузил страницу — переходим на нативный остров. */
    private fun onWebFailed() {
        main.post {
            if (web == null) return@post
            webBroken = true
            removeView()
            if (show) addView()
            refresh()
        }
    }

    fun reloadSprite(mood: String) {
        main.post { (view as? IslandView)?.forget(mood); refresh() }
    }

    /** Наряд и цвета поменялись в приложении — перерисовать живого Тука. */
    fun reloadLook() {
        refresh()
    }

    private val awayDone = Runnable {
        // «уходит в фон» — короткая анимация, дальше Тук просто рядом
        if (Island.mood == "away") {
            Island.mood = "idle"
            refresh()
        }
    }

    fun refresh() {
        main.post {
            val v = view ?: return@post
            val m = Island.wakeMood ?: Island.mood
            if (m != lastMood) {
                lastMood = m
                main.removeCallbacks(awayDone)
                if (m == "away") main.postDelayed(awayDone, 1800)
            }
            // остров прячется, пока открыто приложение (кроме момента, когда Тук слушает «Тук Тук»)
            v.visibility = if (Island.appVisible) View.GONE else View.VISIBLE
            val w = web
            if (w != null) {
                w.state(m, Island.wakeText ?: Island.text, Island.badge, Island.look)
                // экономия батареи: экран выключен или Тук спрятан — кадры не рисуем
                w.pause(!screenOn || Island.appVisible)
            } else {
                (v as? IslandView)?.let {
                    it.paused = !screenOn || Island.appVisible
                    it.update()
                }
            }
        }
    }
}

/**
 * Живой Тук: прозрачный WebView со страницей island-android.html (класс Character, пружины, 60 к/с).
 * Страница и её модули лежат в assets/island плагина и отдаются по https://tuk.island/ —
 * ES-модули с file:// Chromium не грузит.
 */
@SuppressLint("SetJavaScriptEnabled")
class IslandWeb(
    private val ctx: Context,
    private val onWidth: (Int) -> Unit,
    private val onFailed: () -> Unit
) {
    companion object {
        /** Персонаж, dp — совпадает с #tuk в island-android.html. */
        const val CHAR_W_DP = 80
        const val CHAR_H_DP = 64
        private const val HOST = "tuk.island"
        private const val START = "https://$HOST/island-android.html"
    }

    private val main = Handler(Looper.getMainLooper())
    val view: WebView = WebView(ctx)
    private var ready = false
    private var lastState = ""
    private var paused: Boolean? = null
    private var dead = false
    /** Страница не ответила ready() — WebView сломан, нужен нативный остров. */
    private val watchdog: Runnable = object : Runnable {
        override fun run() {
            if (ready || dead) return
            // спрятанный остров мог не успеть — подождать, пока его покажут
            if (view.isShown) onFailed() else main.postDelayed(this, 8000)
        }
    }

    init {
        view.setBackgroundColor(Color.TRANSPARENT)
        view.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.isFocusable = false
        view.isFocusableInTouchMode = false
        view.isLongClickable = false
        view.isHapticFeedbackEnabled = false
        view.setOnLongClickListener { true }
        if (Build.VERSION.SDK_INT >= 26) view.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        val s = view.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = false
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.textZoom = 100
        s.setSupportZoom(false)
        s.builtInZoomControls = false
        s.displayZoomControls = false
        s.mediaPlaybackRequiresUserGesture = true
        s.cacheMode = WebSettings.LOAD_NO_CACHE
        view.addJavascriptInterface(Bridge(), "TukBridge")
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.host != HOST) return empty(404)
                val name = (u.path ?: "").trimStart('/')
                // только плоские имена из assets/island — никаких «../»
                if (name.isEmpty() || name.contains('/') || name.contains("..")) return empty(404)
                val mime = when {
                    name.endsWith(".html") -> "text/html"
                    name.endsWith(".js") -> "text/javascript"
                    name.endsWith(".css") -> "text/css"
                    else -> "application/octet-stream"
                }
                return try {
                    WebResourceResponse(mime, "utf-8", ctx.assets.open("island/$name"))
                } catch (e: Exception) {
                    empty(404)
                }
            }

            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean = true

            @SuppressLint("NewApi")
            override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                // рендерер упал (или его убила система ради памяти) — без этого упадёт всё приложение
                dead = true
                onFailed()
                return true
            }
        }
        view.loadUrl(START)
        main.postDelayed(watchdog, 8000)
    }

    private fun empty(code: Int): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", code, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /** Мост для страницы; методы вызываются из потока JavaBridge, а не из главного. */
    // класс открытый: WebView ищет методы через отражение
    inner class Bridge {
        @JavascriptInterface
        fun ready() {
            main.post {
                if (dead) return@post
                ready = true
                main.removeCallbacks(watchdog)
                // страница могла перезагрузиться — прислать всё заново
                if (lastState.isNotEmpty()) js("window.tukIsland&&tukIsland.state($lastState)")
                val pz = paused
                paused = null
                if (pz != null) pause(pz)
            }
        }

        @JavascriptInterface
        fun bubble(cssWidth: Int) {
            onWidth(cssWidth)
        }
    }

    private fun js(code: String) {
        if (!ready || dead) return
        runCatching { view.evaluateJavascript(code, null) }
    }

    /** Настроение, облачко, значок и наряд (JSON из приложения). Шлём только изменения. */
    fun state(mood: String, text: String, badge: Int, look: String?) {
        val o = JSONObject()
        o.put("mood", mood)
        o.put("text", text)
        o.put("badge", badge)
        if (look != null) runCatching { o.put("look", JSONObject(look)) }
        val st = o.toString()
        if (st == lastState) return
        lastState = st
        js("window.tukIsland&&tukIsland.state($st)")
    }

    fun pause(on: Boolean) {
        if (paused == on) return
        paused = on
        // до загрузки страницы только запоминаем: ready() применит
        if (!ready || dead) return
        js("window.tukIsland&&tukIsland.pause($on)")
        // и сам WebView (pauseTimers не трогаем — он общий с WebView приложения)
        runCatching { if (on) view.onPause() else view.onResume() }
    }

    fun tap() = js("window.tukIsland&&tukIsland.tap()")

    fun fly(vx: Float, vy: Float) {
        if (vx.isNaN() || vy.isNaN()) return
        js("window.tukIsland&&tukIsland.fly(${vx.toInt()},${vy.toInt()})")
    }

    fun land() = js("window.tukIsland&&tukIsland.land()")

    fun destroy() {
        dead = true
        main.removeCallbacks(watchdog)
        runCatching {
            view.stopLoading()
            view.removeJavascriptInterface("TukBridge")
            view.destroy()
        }
    }
}

/**
 * Запасной нативный остров (готовые кадры из Character.sheet), если WebView недоступен.
 * Облачко с текстом — только когда есть что сказать.
 */
class IslandView(ctx: Context) : View(ctx) {
    private val dp = resources.displayMetrics.density
    val charH = (64 * dp).toInt()
    val charW = (80 * dp).toInt()
    var dragging = false
    private val bubbleP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(235, 22, 22, 28) }
    private val bubbleStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(60, 255, 255, 255); style = Paint.Style.STROKE; strokeWidth = 1 * dp
    }
    private val badgeP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 92, 92) }
    private val badgeT = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textSize = 9 * dp; textAlign = Paint.Align.CENTER; isFakeBoldText = true
    }
    private val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 12 * dp }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(244, 196, 112) }
    private val sprites = HashMap<String, Pair<Bitmap, IntArray>>()
    private var frame = 0
    private var shown = ""
    private var textW = 0
    private var bounceUntil = 0L
    private var lastMood = ""
    private val ticker = Handler(Looper.getMainLooper())
    /** Экран выключен или Тук спрятан — кадры не крутим. */
    var paused = false
        set(on) {
            if (field == on) return
            field = on
            ticker.removeCallbacks(tick)
            if (!on && isAttachedToWindow) ticker.post(tick)
        }
    private val tick = object : Runnable {
        override fun run() {
            if (paused) return
            frame++
            invalidate()
            val fps = sprite(mood())?.second?.get(1) ?: 8
            ticker.postDelayed(this, (1000 / fps.coerceIn(2, 30)).toLong())
        }
    }

    private fun mood(): String = Island.wakeMood ?: Island.mood
    private fun text(): String = Island.wakeText ?: Island.text

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!paused) ticker.post(tick)
    }

    override fun onDetachedFromWindow() {
        ticker.removeCallbacks(tick)
        super.onDetachedFromWindow()
    }

    fun forget(mood: String) {
        sprites.remove(mood)
    }

    private fun sprite(mood: String): Pair<Bitmap, IntArray>? {
        sprites[mood]?.let { return it }
        val dir = Island.spriteDir(context)
        val png = File(dir, "$mood.png")
        if (!png.exists()) return if (mood != "idle") sprite("idle") else null
        val meta = runCatching { File(dir, "$mood.meta").readText().split(",").map { it.trim().toInt() } }.getOrNull() ?: listOf(1, 8)
        val bmp = BitmapFactory.decodeFile(png.absolutePath) ?: return null
        val pair = bmp to intArrayOf(meta[0], meta[1])
        sprites[mood] = pair
        return pair
    }

    fun bounce() {
        bounceUntil = System.currentTimeMillis() + 220
        invalidate()
    }

    fun update() {
        val m = mood()
        if (m != lastMood) {
            lastMood = m
            frame = 0
        }
        val t = text()
        if (t != shown) {
            shown = t
            textW = if (t.isEmpty()) 0 else tp.measureText(t).toInt().coerceAtMost((160 * dp).toInt())
            requestLayout()
        }
        invalidate()
    }

    private fun bubbleW(): Int = if (textW > 0) textW + (20 * dp).toInt() else 0

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(charW + bubbleW(), charH)
    }

    override fun onDraw(c: Canvas) {
        val s = if (System.currentTimeMillis() < bounceUntil) 0.92f else 1f
        c.save()
        c.scale(s, s, charW / 2f, charH.toFloat())
        val sp = sprite(mood())
        val dst = Rect(0, 0, charW, charH)
        if (sp != null) {
            val (bmp, meta) = sp
            val n = meta[0].coerceAtLeast(1)
            val fw = bmp.width / n
            val i = frame % n
            c.drawBitmap(bmp, Rect(i * fw, 0, (i + 1) * fw, bmp.height), dst, null)
        } else {
            c.drawCircle(charW / 2f, charH / 2f, 8 * dp, dot)
        }
        if (Island.badge > 0) {
            val bx = charW * 0.72f
            val by = 10 * dp
            c.drawCircle(bx, by, 7 * dp, badgeP)
            c.drawText(Island.badge.coerceAtMost(9).toString(), bx, by + 3 * dp, badgeT)
        }
        c.restore()

        // облачко с текстом справа от Тука, на уровне лица
        if (textW > 0) {
            val h = 26 * dp
            val top = charH * 0.36f - h / 2
            val left = charW - 6 * dp
            val r = RectF(left, top, left + bubbleW() - 2 * dp, top + h)
            c.drawRoundRect(r, h / 2, h / 2, bubbleP)
            c.drawRoundRect(r, h / 2, h / 2, bubbleStroke)
            val str = TextUtils.ellipsize(shown, tp, textW.toFloat(), TextUtils.TruncateAt.END).toString()
            val y = r.centerY() - (tp.descent() + tp.ascent()) / 2
            c.drawText(str, left + 10 * dp, y, tp)
        }
    }
}
