//! C-структуры и типы функций libvosk.dll и sherpa-onnx-c-api.dll.
//! Библиотеки грузятся на лету (LoadLibrary), поэтому Тук запускается и без них.
//! Раскладка структур sherpa-onnx сверена с c-api.h версии v1.13.8 (gcc: sizeof/offsetof),
//! см. тест ниже — версия библиотеки в сборке закреплена в .github/workflows/build.yml.

use std::ffi::{c_char, c_void};

// ---------------- Vosk (vosk_api.h, 0.3.45) ----------------

pub type VoskModelNew = unsafe extern "C" fn(path: *const c_char) -> *mut c_void;
pub type VoskRecognizerNew = unsafe extern "C" fn(model: *mut c_void, sample_rate: f32) -> *mut c_void;
pub type VoskAcceptWaveformS = unsafe extern "C" fn(rec: *mut c_void, data: *const i16, length: i32) -> i32;
pub type VoskResult = unsafe extern "C" fn(rec: *mut c_void) -> *const c_char;
pub type VoskRecognizerVoid = unsafe extern "C" fn(rec: *mut c_void);
pub type VoskSetLogLevel = unsafe extern "C" fn(level: i32);

// ---------------- sherpa-onnx (c-api.h, v1.13.8) ----------------

/// SherpaOnnxOfflineTtsVitsModelConfig — 56 байт.
#[repr(C)]
pub struct TtsVits {
    pub model: *const c_char,
    pub lexicon: *const c_char,
    pub tokens: *const c_char,
    pub data_dir: *const c_char,
    pub noise_scale: f32,
    pub noise_scale_w: f32,
    pub length_scale: f32,
    pub dict_dir: *const c_char,
}

/// SherpaOnnxOfflineTtsModelConfig — 416 байт. После provider идут конфиги
/// matcha, kokoro, kitten, zipvoice, pocket, supertonic: Туку они не нужны,
/// поэтому это просто нули (все поля там — указатели и числа, ноль = «не задано»).
#[repr(C)]
pub struct TtsModel {
    pub vits: TtsVits,
    pub num_threads: i32,
    pub debug: i32,
    pub provider: *const c_char,
    pub other: [u64; 43],
}

/// SherpaOnnxOfflineTtsConfig — 448 байт.
#[repr(C)]
pub struct TtsConfig {
    pub model: TtsModel,
    pub rule_fsts: *const c_char,
    pub max_num_sentences: i32,
    pub rule_fars: *const c_char,
    pub silence_scale: f32,
}

/// SherpaOnnxGeneratedAudio.
#[repr(C)]
pub struct GeneratedAudio {
    pub samples: *const f32,
    pub n: i32,
    pub sample_rate: i32,
}

pub type TtsCreate = unsafe extern "C" fn(cfg: *const TtsConfig) -> *const c_void;
pub type TtsDestroy = unsafe extern "C" fn(tts: *const c_void);
pub type TtsGenerate = unsafe extern "C" fn(tts: *const c_void, text: *const c_char, sid: i32, speed: f32) -> *const GeneratedAudio;
pub type TtsAudioFree = unsafe extern "C" fn(audio: *const GeneratedAudio);

#[cfg(all(test, target_pointer_width = "64"))]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    /// Числа — из gcc по c-api.h v1.13.8 (sizeof/offsetof).
    #[test]
    fn sherpa_layout() {
        assert_eq!(size_of::<TtsVits>(), 56);
        assert_eq!(size_of::<TtsModel>(), 416);
        assert_eq!(offset_of!(TtsModel, num_threads), 56);
        assert_eq!(offset_of!(TtsModel, provider), 64);
        assert_eq!(size_of::<TtsConfig>(), 448);
        assert_eq!(offset_of!(TtsConfig, rule_fsts), 416);
        assert_eq!(offset_of!(TtsConfig, max_num_sentences), 424);
        assert_eq!(offset_of!(TtsConfig, rule_fars), 432);
        assert_eq!(offset_of!(TtsConfig, silence_scale), 440);
        assert_eq!(size_of::<GeneratedAudio>(), 16);
    }
}
