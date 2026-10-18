# Мозг Тука на Android: llama.cpp + тонкая JNI-обёртка (libtukllm.so).
# Собирается в CI отдельно от Gradle; результат кладётся в android/src/main/jniLibs/arm64-v8a.
cmake_minimum_required(VERSION 3.22)
project(tukllm C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(LLAMA_DIR "" CACHE PATH "Путь к исходникам llama.cpp")
if(NOT LLAMA_DIR)
  message(FATAL_ERROR "Укажите -DLLAMA_DIR=<путь к llama.cpp>")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_WEBUI OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

add_subdirectory(${LLAMA_DIR} llama-build EXCLUDE_FROM_ALL)

add_library(tukllm SHARED tuk_llm.cpp)
target_link_libraries(tukllm PRIVATE llama)
if(ANDROID)
  target_link_libraries(tukllm PRIVATE log)
  # убрать лишние символы — меньше .so
  target_link_options(tukllm PRIVATE -Wl,--gc-sections -Wl,--exclude-libs,ALL)
endif()
