package ru.tuk.plugin

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
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
import android.text.TextUtils
import android.text.TextPaint
import android.util.Base64
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import java.io.File

/** Общее состояние острова: его меняет и плагин (из JS), и сам остров. */
object Island {
    @Volatile var mood: String = "idle"
    @Volatile var text: String = ""
    @Volatile var badge: Int = 0
    /** Приложение открыто нажатием на остров — показать выпадающее окно. */
    @Volatile var drop: Boolean = false
    /** Приложение на экране — остров прячется. */
    @Volatile var appVisible: Boolean = false
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
}

class IslandService : Service() {
    private lateinit var wm: WindowManager
    private var view: IslandView? = null
    private var params: WindowManager.LayoutParams? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Island.service = this
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        startAsForeground()
        addView()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        Island.service = null
        view?.let { runCatching { wm.removeView(it) } }
        view = null
        super.onDestroy()
    }

    private fun startAsForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel("tuk_island", "Тук над приложениями", NotificationManager.IMPORTANCE_MIN)
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
        val open = PendingIntent.getActivity(
            this, 1, launchIntent(false),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "tuk_island") else Notification.Builder(this)
        val n = b.setContentTitle("Тук рядом")
            .setContentText("Нажмите на Тука вверху экрана")
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(7101, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(7101, n)
        }
    }

    fun launchIntent(drop: Boolean): Intent {
        val i = packageManager.getLaunchIntentForPackage(packageName) ?: Intent()
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        i.putExtra("tuk_drop", drop)
        return i
    }

    fun openApp(drop: Boolean) {
        Island.drop = drop
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
        val gd = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                v.bounce()
                openApp(true)
                return true
            }
            override fun onLongPress(e: MotionEvent) {
                openApp(false)
            }
        })
        v.setOnTouchListener { _, e -> gd.onTouchEvent(e) }
        view = v
        params = p
        wm.addView(v, p)
        refresh()
    }

    fun reloadSprite(mood: String) {
        main.post { view?.forget(mood); refresh() }
    }

    fun refresh() {
        main.post {
            val v = view ?: return@post
            val p = params ?: return@post
            v.visibility = if (Island.appVisible) View.GONE else View.VISIBLE
            v.update()
            // пилюля вокруг вырезки камеры, по центру экрана
            val screenW = resources.displayMetrics.widthPixels
            p.x = (screenW / 2 - v.gapCenter()).coerceAtLeast(0)
            p.y = v.topOffset()
            runCatching { wm.updateViewLayout(v, p) }
        }
    }
}

/** Чёрная капсула: слева анимированный Тук, посередине — место под камеру, справа текст. */
class IslandView(ctx: Context) : View(ctx) {
    private val dp = resources.displayMetrics.density
    private val pillH = (34 * dp).toInt()
    private val charSize = (30 * dp).toInt()
    private val pad = (4 * dp).toInt()
    private val pill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK }
    private val badgeP = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 92, 92) }
    private val badgeT = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; textSize = 9 * dp; textAlign = Paint.Align.CENTER; isFakeBoldText = true
    }
    private val tp = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 12 * dp }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val sprites = HashMap<String, Pair<Bitmap, IntArray>>()
    private var frame = 0
    private var shown = ""
    private var gap = (30 * dp).toInt()
    private var textW = 0
    private var bounceUntil = 0L
    private val ticker = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            frame++
            invalidate()
            val fps = sprite(Island.mood)?.second?.get(1) ?: 8
            ticker.postDelayed(this, (1000 / fps.coerceIn(2, 30)).toLong())
        }
    }

    init {
        // ширина выреза камеры, если система его сообщает
        if (Build.VERSION.SDK_INT >= 30) {
            runCatching {
                val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                val cut = wm.currentWindowMetrics.windowInsets.displayCutout
                val r = cut?.boundingRects?.firstOrNull { it.top == 0 }
                if (r != null && r.width() < 120 * dp) gap = r.width() + (10 * dp).toInt()
            }
        }
    }

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

    fun gapCenter(): Int = pad + charSize + gap / 2

    fun topOffset(): Int {
        val id = resources.getIdentifier("status_bar_height", "dimen", "android")
        val sb = if (id > 0) resources.getDimensionPixelSize(id) else (28 * dp).toInt()
        return ((sb - pillH) / 2).coerceAtLeast(0)
    }

    fun update() {
        val t = Island.text
        if (t != shown) {
            shown = t
            textW = if (t.isEmpty()) 0 else tp.measureText(t).toInt().coerceAtMost((150 * dp).toInt())
        }
        requestLayout()
        invalidate()
    }

    private fun rightW(): Int = if (textW > 0) textW + (12 * dp).toInt() else charSize

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(pad + charSize + gap + rightW() + pad, pillH + (6 * dp).toInt())
    }

    override fun onDraw(c: Canvas) {
        val w = measuredWidth.toFloat()
        val s = if (System.currentTimeMillis() < bounceUntil) 0.94f else 1f
        c.save()
        c.scale(s, s, w / 2, pillH / 2f)
        c.drawRoundRect(RectF(0f, 0f, w, pillH.toFloat()), pillH / 2f, pillH / 2f, pill)

        // персонаж
        val sp = sprite(Island.mood)
        val top = (pillH - charSize) / 2
        val dst = Rect(pad, top, pad + charSize, top + charSize)
        if (sp != null) {
            val (bmp, meta) = sp
            val n = meta[0].coerceAtLeast(1)
            val fw = bmp.width / n
            val i = frame % n
            c.drawBitmap(bmp, Rect(i * fw, 0, (i + 1) * fw, bmp.height), dst, null)
        } else {
            dot.color = Color.rgb(244, 196, 112)
            c.drawCircle(dst.exactCenterX(), dst.exactCenterY(), 6 * dp, dot)
        }

        // справа — текст или огонёк настроения
        val x0 = (pad + charSize + gap).toFloat()
        if (textW > 0) {
            val str = TextUtils.ellipsize(shown, tp, textW.toFloat(), TextUtils.TruncateAt.END).toString()
            val y = pillH / 2f - (tp.descent() + tp.ascent()) / 2
            c.drawText(str, x0 + 2 * dp, y, tp)
        } else {
            dot.color = moodColor(Island.mood)
            val pulse = 0.75f + 0.25f * Math.sin(frame / 3.0).toFloat()
            dot.alpha = (255 * pulse).toInt()
            c.drawCircle(x0 + charSize / 2f, pillH / 2f, 4 * dp, dot)
        }

        if (Island.badge > 0) {
            val bx = pad + charSize - 3 * dp
            val by = 7 * dp
            c.drawCircle(bx, by, 6 * dp, badgeP)
            c.drawText(Island.badge.coerceAtMost(9).toString(), bx, by + 3 * dp, badgeT)
        }
        c.restore()
    }

    private fun moodColor(m: String): Int = when (m) {
        "sleep" -> Color.rgb(110, 120, 190)
        "think" -> Color.rgb(120, 200, 255)
        "write" -> Color.rgb(140, 230, 160)
        "happy", "dance" -> Color.rgb(255, 140, 190)
        "angry" -> Color.rgb(255, 80, 70)
        "alert" -> Color.rgb(255, 180, 60)
        "listen" -> Color.rgb(90, 220, 255)
        else -> Color.rgb(244, 196, 112)
    }
}
