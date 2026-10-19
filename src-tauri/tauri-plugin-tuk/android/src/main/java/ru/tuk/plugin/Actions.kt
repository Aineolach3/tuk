package ru.tuk.plugin

import android.Manifest
import android.app.Activity
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings
import android.view.KeyEvent
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject

/** Действия на телефоне по командам Тука. Каждое возвращает JSObject {ok, ...} или бросает исключение с понятным текстом. */
class Actions(private val activity: Activity) {

    private fun granted(p: String) = ContextCompat.checkSelfPermission(activity, p) == PackageManager.PERMISSION_GRANTED

    fun hasPermission(which: String): Boolean = when (which) {
        "contacts" -> granted(Manifest.permission.READ_CONTACTS)
        "call" -> granted(Manifest.permission.CALL_PHONE)
        "mic" -> granted(Manifest.permission.RECORD_AUDIO)
        else -> true
    }

    fun request(which: String) {
        val p = when (which) {
            "contacts" -> Manifest.permission.READ_CONTACTS
            "call" -> Manifest.permission.CALL_PHONE
            "mic" -> Manifest.permission.RECORD_AUDIO
            else -> return
        }
        ActivityCompat.requestPermissions(activity, arrayOf(p), 4720)
    }

    private fun start(i: Intent) {
        try {
            activity.startActivity(i)
        } catch (e: ActivityNotFoundException) {
            throw Exception("На телефоне нет приложения для этого")
        }
    }

    fun alarm(hour: Int, minute: Int, label: String?, days: List<Int>?) {
        val i = Intent(AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(AlarmClock.EXTRA_HOUR, hour)
            putExtra(AlarmClock.EXTRA_MINUTES, minute)
            putExtra(AlarmClock.EXTRA_MESSAGE, label ?: "Тук")
            putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            if (!days.isNullOrEmpty()) putExtra(AlarmClock.EXTRA_DAYS, ArrayList(days))
        }
        start(i)
    }

    fun timer(seconds: Int, label: String?) {
        val i = Intent(AlarmClock.ACTION_SET_TIMER).apply {
            putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            putExtra(AlarmClock.EXTRA_MESSAGE, label ?: "Тук")
            putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        }
        start(i)
    }

    fun contacts(): JSArray {
        if (!granted(Manifest.permission.READ_CONTACTS)) throw Exception("perm:contacts")
        val map = LinkedHashMap<String, MutableList<String>>()
        activity.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
            null, null, null
        )?.use { c ->
            while (c.moveToNext()) {
                val name = c.getString(0) ?: continue
                val num = c.getString(1) ?: continue
                val list = map.getOrPut(name) { mutableListOf() }
                val clean = num.replace(Regex("[^\\d+]"), "")
                if (list.none { it.replace(Regex("[^\\d+]"), "").takeLast(10) == clean.takeLast(10) }) list.add(num)
            }
        }
        val arr = JSArray()
        for ((name, phones) in map) {
            val o = JSObject()
            o.put("name", name)
            val p = JSArray()
            phones.forEach { p.put(it) }
            o.put("phones", p)
            arr.put(o)
        }
        return arr
    }

    /** Позвонить: сразу, если разрешено, иначе открыть набор номера. */
    fun call(number: String): Boolean {
        val uri = Uri.parse("tel:" + Uri.encode(number))
        return if (granted(Manifest.permission.CALL_PHONE)) {
            start(Intent(Intent.ACTION_CALL, uri))
            true
        } else {
            start(Intent(Intent.ACTION_DIAL, uri))
            false
        }
    }

    fun sms(number: String, text: String) {
        val i = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number))).apply {
            putExtra("sms_body", text)
        }
        start(i)
    }

    fun apps(): JSArray {
        val pm = activity.packageManager
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val list = if (Build.VERSION.SDK_INT >= 33) pm.queryIntentActivities(main, PackageManager.ResolveInfoFlags.of(0))
        else @Suppress("DEPRECATION") pm.queryIntentActivities(main, 0)
        val arr = JSArray()
        val seen = HashSet<String>()
        for (r in list) {
            val pkg = r.activityInfo.packageName
            if (!seen.add(pkg)) continue
            val o = JSObject()
            o.put("label", r.loadLabel(pm).toString())
            o.put("pkg", pkg)
            arr.put(o)
        }
        return arr
    }

    fun open(pkg: String) {
        val i = activity.packageManager.getLaunchIntentForPackage(pkg) ?: throw Exception("Приложение не найдено")
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        start(i)
    }

    fun url(u: String) {
        start(Intent(Intent.ACTION_VIEW, Uri.parse(u)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun torch(on: Boolean) {
        val cm = activity.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
            ?: throw Exception("У телефона нет вспышки")
        cm.setTorchMode(id, on)
    }

    fun volume(dir: String): Int {
        val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val s = AudioManager.STREAM_MUSIC
        when (dir) {
            "up" -> repeat(2) { am.adjustStreamVolume(s, AudioManager.ADJUST_RAISE, if (it == 1) AudioManager.FLAG_SHOW_UI else 0) }
            "down" -> repeat(2) { am.adjustStreamVolume(s, AudioManager.ADJUST_LOWER, if (it == 1) AudioManager.FLAG_SHOW_UI else 0) }
            "mute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI)
            "unmute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, AudioManager.FLAG_SHOW_UI)
            "max" -> am.setStreamVolume(s, am.getStreamMaxVolume(s), AudioManager.FLAG_SHOW_UI)
        }
        return am.getStreamVolume(s) * 100 / maxOf(1, am.getStreamMaxVolume(s))
    }

    fun media(key: String) {
        val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val code = when (key) {
            "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "prev" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
        }
        val t = SystemClock.uptimeMillis()
        am.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0))
        am.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0))
    }

    fun navigate(place: String) {
        // Яндекс Навигатор / Карты, если есть, иначе любое приложение карт
        val pm = activity.packageManager
        val yandex = Intent(Intent.ACTION_VIEW, Uri.parse("yandexnavi://map_search?text=" + Uri.encode(place)))
        if (yandex.resolveActivity(pm) != null) return start(yandex)
        val gmaps = Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + Uri.encode(place)))
        if (gmaps.resolveActivity(pm) != null) return start(gmaps)
        start(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(place))))
    }

    fun search(q: String) {
        val i = Intent(Intent.ACTION_WEB_SEARCH).putExtra(SearchManager.QUERY, q)
        try {
            activity.startActivity(i)
        } catch (e: ActivityNotFoundException) {
            url("https://yandex.ru/search/?text=" + Uri.encode(q))
        }
    }

    fun battery(): JSObject {
        val bm = activity.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val o = JSObject()
        o.put("level", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
        o.put("charging", bm.isCharging)
        return o
    }

    fun calendar(title: String, begin: Long, end: Long) {
        val i = Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI).apply {
            putExtra(CalendarContract.Events.TITLE, title)
            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin)
            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
        }
        start(i)
    }

    fun camera() {
        start(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA))
    }

    fun settings(which: String) {
        val action = when (which) {
            "wifi" -> if (Build.VERSION.SDK_INT >= 29) Settings.Panel.ACTION_WIFI else Settings.ACTION_WIFI_SETTINGS
            "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
            "location" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
            "display" -> Settings.ACTION_DISPLAY_SETTINGS
            "sound" -> if (Build.VERSION.SDK_INT >= 29) Settings.Panel.ACTION_VOLUME else Settings.ACTION_SOUND_SETTINGS
            else -> Settings.ACTION_SETTINGS
        }
        start(Intent(action))
    }

    // ---------- Будильники и таймеры (официальные интенты «Часов») ----------

    fun alarmControl(op: String) {
        val action = when (op) {
            "dismiss" -> AlarmClock.ACTION_DISMISS_ALARM
            "snooze" -> AlarmClock.ACTION_SNOOZE_ALARM
            "showTimers" -> if (Build.VERSION.SDK_INT >= 26) AlarmClock.ACTION_SHOW_TIMERS else AlarmClock.ACTION_SHOW_ALARMS
            else -> AlarmClock.ACTION_SHOW_ALARMS
        }
        val i = Intent(action)
        if (op == "dismiss" || op == "snooze") i.putExtra(AlarmClock.EXTRA_ALARM_SEARCH_MODE, AlarmClock.ALARM_SEARCH_MODE_ALL)
        try {
            activity.startActivity(i)
        } catch (e: ActivityNotFoundException) {
            // «Часы» не поддержали прямую команду — открываем список будильников
            start(Intent(AlarmClock.ACTION_SHOW_ALARMS))
        }
    }

    // ---------- Не беспокоить ----------

    private fun notifManager() = activity.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager

    fun canDnd(): Boolean = Build.VERSION.SDK_INT < 23 || notifManager().isNotificationPolicyAccessGranted

    fun askDnd() {
        start(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
    }

    fun dnd(on: Boolean): Boolean {
        if (!canDnd()) return false
        val nm = notifManager()
        nm.setInterruptionFilter(
            if (on) android.app.NotificationManager.INTERRUPTION_FILTER_PRIORITY
            else android.app.NotificationManager.INTERRUPTION_FILTER_ALL
        )
        return true
    }

    // ---------- Режим звонка ----------

    fun ringer(mode: String): Boolean {
        val am = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        // перевод в «беззвучно»/«вибро» требует доступа к «Не беспокоить» на части прошивок
        if ((mode == "silent" || mode == "vibrate") && Build.VERSION.SDK_INT >= 23 && !canDnd()) return false
        am.ringerMode = when (mode) {
            "silent" -> AudioManager.RINGER_MODE_SILENT
            "vibrate" -> AudioManager.RINGER_MODE_VIBRATE
            else -> AudioManager.RINGER_MODE_NORMAL
        }
        return true
    }

    // ---------- Яркость и автоповорот (Settings.System, нужен WRITE_SETTINGS) ----------

    fun canWriteSystem(): Boolean = Build.VERSION.SDK_INT < 23 || Settings.System.canWrite(activity)

    fun askWriteSystem() {
        val i = Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + activity.packageName))
        try {
            activity.startActivity(i)
        } catch (e: ActivityNotFoundException) {
            start(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS))
        }
    }

    fun brightness(dir: String): Int {
        val cr = activity.contentResolver
        if (dir == "auto") {
            Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC)
            return -1
        }
        Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
        val cur = Settings.System.getInt(cr, Settings.System.SCREEN_BRIGHTNESS, 128)
        val next = when (dir) {
            "max" -> 255
            "min" -> 10
            "up" -> (cur + 55).coerceAtMost(255)
            else -> (cur - 55).coerceAtLeast(5)
        }
        Settings.System.putInt(cr, Settings.System.SCREEN_BRIGHTNESS, next)
        return next * 100 / 255
    }

    fun rotate(lock: Boolean): Boolean {
        Settings.System.putInt(activity.contentResolver, Settings.System.ACCELEROMETER_ROTATION, if (lock) 0 else 1)
        return true
    }
}
