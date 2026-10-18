// JNI-обёртка llama.cpp для Тука на Android.
// Модель читается с диска через mmap (а не копируется в память, как в WebView) — поэтому
// приложение больше не падает на моделях в 1–2 ГБ. Ответ отдаётся по кусочкам в Kotlin.

#include <jni.h>
#include <atomic>
#include <cstring>
#include <mutex>
#include <random>
#include <string>
#include <vector>

#include "llama.h"

#ifdef __ANDROID__
#include <android/log.h>
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, "tuk-llm", __VA_ARGS__)
#else
#include <cstdio>
#define LOGW(...) (fprintf(stderr, __VA_ARGS__), fputc('\n', stderr))
#endif

namespace {

llama_model *g_model = nullptr;
llama_context *g_ctx = nullptr;
std::vector<llama_token> g_cache;  // токены, уже лежащие в KV-кэше (для повторного использования префикса)
std::atomic<bool> g_stop{false};
std::mutex g_mu;
bool g_inited = false;

void log_cb(ggml_log_level level, const char *text, void *) {
    if (level >= GGML_LOG_LEVEL_WARN) LOGW("%s", text);
}

void unload_locked() {
    if (g_ctx) llama_free(g_ctx);
    if (g_model) llama_model_free(g_model);
    g_ctx = nullptr;
    g_model = nullptr;
    g_cache.clear();
}

// Длина начала строки, состоящего только из целых UTF-8 символов.
size_t utf8_complete_prefix(const std::string &s) {
    size_t i = s.size();
    // ищем начало последнего символа (не более 3 байт назад)
    size_t back = 0;
    while (i > 0 && back < 4) {
        unsigned char c = (unsigned char) s[i - 1];
        if ((c & 0xC0) != 0x80) {
            size_t need = (c & 0x80) == 0 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
            size_t have = s.size() - (i - 1);
            return have >= need ? s.size() : i - 1;
        }
        --i;
        ++back;
    }
    return s.size();
}

std::string bytes_of(JNIEnv *env, jbyteArray arr) {
    if (!arr) return {};
    jsize n = env->GetArrayLength(arr);
    std::string s((size_t) n, '\0');
    if (n > 0) env->GetByteArrayRegion(arr, 0, n, reinterpret_cast<jbyte *>(&s[0]));
    return s;
}

std::string str_of(JNIEnv *env, jstring js) {
    if (!js) return {};
    const char *c = env->GetStringUTFChars(js, nullptr);
    std::string s(c ? c : "");
    if (c) env->ReleaseStringUTFChars(js, c);
    return s;
}

std::vector<llama_token> tokenize(const llama_vocab *vocab, const std::string &text) {
    int n = -llama_tokenize(vocab, text.data(), (int32_t) text.size(), nullptr, 0, true, true);
    if (n <= 0) return {};
    std::vector<llama_token> out((size_t) n);
    int got = llama_tokenize(vocab, text.data(), (int32_t) text.size(), out.data(), n, true, true);
    if (got < 0) return {};
    out.resize((size_t) got);
    return out;
}

std::string apply_template(const std::vector<std::string> &roles, const std::vector<std::string> &contents) {
    std::vector<llama_chat_message> msgs;
    msgs.reserve(roles.size());
    size_t total = 0;
    for (size_t i = 0; i < roles.size(); i++) {
        msgs.push_back({roles[i].c_str(), contents[i].c_str()});
        total += contents[i].size();
    }
    const char *tmpl = llama_model_chat_template(g_model, nullptr);
    std::vector<char> buf(total * 2 + 2048);
    int n = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), (int32_t) buf.size());
    if (n < 0) {
        // шаблон модели не распознан — используем ChatML (Qwen, многие другие)
        tmpl = "chatml";
        n = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), (int32_t) buf.size());
    }
    if (n > (int) buf.size()) {
        buf.resize((size_t) n + 16);
        n = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), (int32_t) buf.size());
    }
    if (n < 0) return {};
    return std::string(buf.data(), (size_t) n);
}

}  // namespace

extern "C" {

JNIEXPORT jboolean JNICALL
Java_ru_tuk_plugin_Llm_nativeLoad(JNIEnv *env, jobject, jstring jpath, jint n_ctx, jint n_threads) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_inited) {
        llama_log_set(log_cb, nullptr);
        llama_backend_init();
        g_inited = true;
    }
    unload_locked();
    std::string path = str_of(env, jpath);
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    mp.use_mmap = true;
    g_model = llama_model_load_from_file(path.c_str(), mp);
    if (!g_model) {
        LOGW("не удалось загрузить модель: %s", path.c_str());
        return JNI_FALSE;
    }
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = (uint32_t) n_ctx;
    cp.n_batch = 512;
    cp.n_ubatch = 512;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    g_ctx = llama_init_from_model(g_model, cp);
    if (!g_ctx) {
        unload_locked();
        return JNI_FALSE;
    }
    return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_ru_tuk_plugin_Llm_nativeUnload(JNIEnv *, jobject) {
    g_stop = true;
    std::lock_guard<std::mutex> lock(g_mu);
    unload_locked();
}

JNIEXPORT void JNICALL
Java_ru_tuk_plugin_Llm_nativeStop(JNIEnv *, jobject) {
    g_stop = true;
}

/**
 * Ответ на разговор. roles — "system"/"user"/"assistant", contents — UTF-8 байты.
 * sink.onToken(byte[]) получает кусочки ответа (целые символы UTF-8) и возвращает false, чтобы остановить.
 * Возвращает число сгенерированных токенов или отрицательный код ошибки.
 */
JNIEXPORT jint JNICALL
Java_ru_tuk_plugin_Llm_nativeChat(JNIEnv *env, jobject, jobjectArray jroles, jobjectArray jcontents,
                                  jint max_tokens, jfloat temp, jfloat top_p, jint top_k, jobject sink) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_model || !g_ctx) return -1;
    g_stop = false;

    jclass sink_cls = env->GetObjectClass(sink);
    jmethodID on_token = env->GetMethodID(sink_cls, "onToken", "([B)Z");
    if (!on_token) return -6;

    const jsize n_msg = env->GetArrayLength(jroles);
    std::vector<std::string> roles, contents;
    for (jsize i = 0; i < n_msg; i++) {
        auto r = (jstring) env->GetObjectArrayElement(jroles, i);
        auto c = (jbyteArray) env->GetObjectArrayElement(jcontents, i);
        roles.push_back(str_of(env, r));
        contents.push_back(bytes_of(env, c));
        env->DeleteLocalRef(r);
        env->DeleteLocalRef(c);
    }

    const std::string prompt = apply_template(roles, contents);
    if (prompt.empty()) return -2;
    const llama_vocab *vocab = llama_model_get_vocab(g_model);
    std::vector<llama_token> tokens = tokenize(vocab, prompt);
    if (tokens.empty()) return -3;

    const int n_ctx = (int) llama_n_ctx(g_ctx);
    if ((int) tokens.size() + max_tokens + 8 > n_ctx) {
        // слишком длинно — оставляем конец разговора (начало с системной частью обрезается)
        const int keep = n_ctx - max_tokens - 8;
        if (keep < 64) return -4;
        tokens.erase(tokens.begin(), tokens.end() - keep);
    }

    // общий префикс с прошлым запросом уже посчитан — пересчитываем только новое
    size_t p = 0;
    while (p < g_cache.size() && p < tokens.size() && g_cache[p] == tokens[p]) p++;
    if (p == tokens.size()) p--;  // хотя бы один токен нужно прогнать, чтобы получить вероятности
    llama_memory_t mem = llama_get_memory(g_ctx);
    if (!llama_memory_seq_rm(mem, 0, (llama_pos) p, -1)) {
        llama_memory_clear(mem, true);
        p = 0;
    }
    g_cache.resize(p);

    for (size_t i = p; i < tokens.size(); i += 512) {
        const int n = (int) std::min<size_t>(512, tokens.size() - i);
        if (llama_decode(g_ctx, llama_batch_get_one(&tokens[i], n)) != 0) {
            llama_memory_clear(mem, true);
            g_cache.clear();
            return -5;
        }
        g_cache.insert(g_cache.end(), tokens.begin() + (long) i, tokens.begin() + (long) i + n);
        if (g_stop) return 0;
    }

    llama_sampler *smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_top_k(top_k));
    llama_sampler_chain_add(smpl, llama_sampler_init_penalties(64, 1.1f, 0.0f, 0.0f));
    llama_sampler_chain_add(smpl, llama_sampler_init_top_p(top_p, 1));
    llama_sampler_chain_add(smpl, llama_sampler_init_temp(temp));
    llama_sampler_chain_add(smpl, llama_sampler_init_dist((uint32_t) std::random_device{}()));

    std::string pending;
    int produced = 0;
    char piece[256];
    for (; produced < max_tokens; produced++) {
        if (g_stop || (int) g_cache.size() >= n_ctx - 2) break;
        llama_token tok = llama_sampler_sample(smpl, g_ctx, -1);
        if (llama_vocab_is_eog(vocab, tok)) break;
        int n = llama_token_to_piece(vocab, tok, piece, sizeof(piece), 0, false);
        if (n > 0) pending.append(piece, (size_t) n);
        const size_t ready = utf8_complete_prefix(pending);
        if (ready > 0) {
            jbyteArray arr = env->NewByteArray((jsize) ready);
            env->SetByteArrayRegion(arr, 0, (jsize) ready, reinterpret_cast<const jbyte *>(pending.data()));
            jboolean go = env->CallBooleanMethod(sink, on_token, arr);
            env->DeleteLocalRef(arr);
            pending.erase(0, ready);
            if (env->ExceptionCheck()) {
                env->ExceptionClear();
                break;
            }
            if (!go) break;
        }
        if (llama_decode(g_ctx, llama_batch_get_one(&tok, 1)) != 0) break;
        g_cache.push_back(tok);
    }
    llama_sampler_free(smpl);
    return produced;
}

}  // extern "C"
