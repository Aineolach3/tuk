package ru.tuk.plugin

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
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
import android.text.TextPaint
import android.text.TextUtils
import android.util.Base64
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import androidx.core.content.ContextCompat
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
    var service: IslandService? = null

    fun spriteDir(ctx: Context): File = File(ctx.filesDir, "island").apply { mkdirs() }

    fun saveSprite(ctx: Context, mood: String, b64: String, frames: Int, fps: Int) {
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        File(spriteDir(ctx), "$mood.png").writeBytes(bytes)
        File(spriteDir(ctx), "$mood.meta").writeText("$frames,$fps")
        service?.reloadSprite(mood)
    }

    fun refresh() {
        service?.refresh()
    }

    fun prefs(ctx: Context) = ctx.getSharedPreferences("tuk_island", Context.MODE_PRIVATE)
}

class IslandService : Service() {
    private lateinit var wm: WindowManager
    private var view: IslandView? = null
    private var params: WindowManager.LayoutParams? = null
    private val main = Handler(Looper.getMainLooper())
    var wake: Wake? = null
    private var show = true
    private var wakeOn = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Island.service = this
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val p = Island.prefs(this)
        show = p.getBoolean("show", true)
        wakeOn = p.getBoolean("wake", false)
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
        wake?.stop()
        wake = null
        view?.let { runCatching { wm.removeView(it) } }
        view = null
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
        if (!show && view != null) {
            runCatching { wm.removeView(view) }
            view = null
        }
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

    @SuppressLint("ClickableViewAccessibility")
    private fun addView() {
        val v = IslandView(this)
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        val p = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )
        p.gravity = Gravity.TOP or Gravity.START
        if (Build.VERSION.SDK_INT >= 28) {
            p.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        // место с прошлого раза или слева от камеры
        val prefs = Island.prefs(this)
        val screenW = resources.displayMetrics.widthPixels
        p.x = prefs.getInt("x", screenW / 2 - v.charW - (8 * resources.displayMetrics.density).toInt())
        p.y = prefs.getInt("y", 0)

        val gd = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                v.bounce()
                openApp(true)
                return true
            }
            override fun onLongPress(e: MotionEvent) {
                if (!v.dragging) openApp(false)
            }
        })
        var sx = 0f
        var sy = 0f
        var px = 0
        var py = 0
        val slop = 12 * resources.displayMetrics.density
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    sx = e.rawX; sy = e.rawY; px = p.x; py = p.y
                    v.dragging = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - sx
                    val dy = e.rawY - sy
                    if (!v.dragging && (Math.abs(dx) > slop || Math.abs(dy) > slop)) v.dragging = true
                    if (v.dragging) {
                        p.x = (px + dx).toInt().coerceIn(0, resources.displayMetrics.widthPixels - v.charW)
                        p.y = (py + dy).toInt().coerceIn(0, resources.displayMetrics.heightPixels - v.charH)
                        runCatching { wm.updateViewLayout(v, p) }
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (v.dragging) {
                        prefs.edit().putInt("x", p.x).putInt("y", p.y).apply()
                        v.dragging = false
                        val cancel = MotionEvent.obtain(e)
                        cancel.action = MotionEvent.ACTION_CANCEL
                        gd.onTouchEvent(cancel)
                        cancel.recycle()
                        return@setOnTouchListener true
                    }
                }
            }
            if (v.dragging) {
                val cancel = MotionEvent.obtain(e)
                cancel.action = MotionEvent.ACTION_CANCEL
                gd.onTouchEvent(cancel)
                cancel.recycle()
                true
            } else gd.onTouchEvent(e)
        }
        view = v
        params = p
        wm.addView(v, p)
    }

    fun reloadSprite(mood: String) {
        main.post { view?.forget(mood); refresh() }
    }

    fun refresh() {
        main.post {
            val v = view ?: return@post
            // остров прячется, пока открыто приложение (кроме момента, когда Тук слушает «Тук Тук»)
            v.visibility = if (Island.appVisible) View.GONE else View.VISIBLE
            v.update()
        }
    }
}

/** Тук в полный рост поверх приложений; облачко с текстом — только когда есть что сказать. */
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
    private var moodSince = 0L
    private val ticker = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            frame++
            // «уходит в фон» — короткая анимация, дальше Тук просто рядом
            if (Island.mood == "away" && System.currentTimeMillis() - moodSince > 1800) Island.mood = "idle"
            invalidate()
            val fps = sprite(mood())?.second?.get(1) ?: 8
            ticker.postDelayed(this, (1000 / fps.coerceIn(2, 30)).toLong())
        }
    }

    private fun mood(): String = Island.wakeMood ?: Island.mood
    private fun text(): String = Island.wakeText ?: Island.text

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        ticker.post(tick)
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
            moodSince = System.currentTimeMillis()
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
