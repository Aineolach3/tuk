# мост острова: методы с @JavascriptInterface вызываются из JS по имени
-keepclassmembers class ru.tuk.plugin.IslandWeb$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
