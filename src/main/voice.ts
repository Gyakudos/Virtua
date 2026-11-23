import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import whisperFactory, { type WhisperModule } from 'whisper.cpp'
import type { SpokenAudio, TranscriptionResult, VoiceConfig, VoiceStatus } from '../shared/types'
import { localAssetPath } from './assets'
import * as store from './storage'

const SAMPLE_RATE = 16_000
const MAX_TRANSCRIBE_SECONDS = 30
const MAX_SPEAK_CHARS = 2_000

const DEFAULT_CONFIG: VoiceConfig = {
  ttsEngine: 'sapi',
  sapiVoice: '',
  sapiRate: 0,
  piperExecutable: '',
  piperModel: '',
  piperConfig: '',
  sttLanguage: 'en'
}

let activeSpeech: ChildProcess | null = null
let whisperPromise: Promise<WhisperModule> | null = null
let whisperReady = false
let modelBytes: Uint8Array | null = null
let printSink: (line: string) => void = () => {}

export function getVoiceConfig(): VoiceConfig {
  const raw = store.getSetting('voice.config')
  if (!raw) return { ...DEFAULT_CONFIG }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) as Partial<VoiceConfig> }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function setVoiceConfig(config: VoiceConfig): void {
  const safe: VoiceConfig = {
    ttsEngine: config.ttsEngine === 'piper' ? 'piper' : 'sapi',
    sapiVoice: String(config.sapiVoice ?? '').slice(0, 200),
    sapiRate: Math.max(-10, Math.min(10, Number(config.sapiRate) || 0)),
    piperExecutable: String(config.piperExecutable ?? '').slice(0, 1000),
    piperModel: String(config.piperModel ?? '').slice(0, 1000),
    piperConfig: String(config.piperConfig ?? '').slice(0, 1000),
    sttLanguage: String(config.sttLanguage ?? 'en').slice(0, 20) || 'en'
  }
  store.setSetting('voice.config', JSON.stringify(safe))
}

export function sttModelPath(): string {
  if (process.env.VA_VOICE_MODEL) return resolve(process.env.VA_VOICE_MODEL)
  return localAssetPath('voice', 'ggml-tiny.en.bin')
}

export function status(config: VoiceConfig = getVoiceConfig()): VoiceStatus {
  return {
    sapi: process.platform === 'win32',
    whisperModel: sttModelPath(),
    whisperReady: whisperReady && existsSync(sttModelPath()),
    piperConfigured: Boolean(
      config.piperExecutable && existsSync(config.piperExecutable) &&
      config.piperModel && existsSync(config.piperModel)
    ),
    sampleRate: SAMPLE_RATE
  }
}

async function loadWhisper(): Promise<WhisperModule> {
  if (!whisperPromise) {
    whisperPromise = (async () => {
      const modelPath = sttModelPath()
      if (!existsSync(modelPath)) {
        throw new Error(`Local Whisper model is missing: ${modelPath}`)
      }
      const module = await whisperFactory({
        print: (line) => printSink(line),
        printErr: () => {}
      })
      modelBytes = new Uint8Array(readFileSync(modelPath))
      // The WASM module has its own filesystem, so mount the local model file
      // into it. Nothing is uploaded or fetched at runtime.
      const mountedName = `voice-model-${randomUUID()}.bin`
      module.FS_createDataFile('/', mountedName, modelBytes, true, false, true)
      if (!module.init(`/${mountedName}`)) {
        throw new Error('Whisper could not load the local model file.')
      }
      whisperReady = true
      return module
    })().catch((error) => {
      whisperPromise = null
      whisperReady = false
      throw error
    })
  }
  return whisperPromise
}

/** Transcribes 16 kHz mono PCM captured locally in the renderer. */
export async function transcribe(samples: Float32Array, language?: string): Promise<TranscriptionResult> {
  if (samples.length < SAMPLE_RATE / 2) throw new Error('Recording is too short to transcribe.')
  if (samples.length > SAMPLE_RATE * MAX_TRANSCRIBE_SECONDS) {
    throw new Error(`Recording is too long; limit is ${MAX_TRANSCRIBE_SECONDS} seconds.`)
  }

  const module = await loadWhisper()
  const printed: string[] = []
  printSink = (line) => printed.push(line)
  const started = Date.now()
  try {
    module.full_default(samples, language || getVoiceConfig().sttLanguage, false)
  } finally {
    printSink = () => {}
  }

  const text = printed.join('\n')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
    .filter((line) => line && !/^(system_info|operator\(\)|whisper_|ERR)/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    text,
    durationMs: Date.now() - started,
    engine: 'whisper.cpp · ggml-tiny.en (local WASM)'
  }
}

const SAPI_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VA_TTS_TEXT))',
  '$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  "if ($env:VA_TTS_RATE -ne '') { $voice.Rate = [int]$env:VA_TTS_RATE }",
  "if ($env:VA_TTS_VOICE -ne '') { try { $voice.SelectVoice($env:VA_TTS_VOICE) } catch {} }",
  '$voice.SetOutputToWaveFile($env:VA_TTS_OUT)',
  '$voice.Speak($text)',
  '$voice.Dispose()'
].join('; ')

function runSynth(child: ChildProcess, outputPath: string, text: string): Promise<SpokenAudio> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    activeSpeech = child
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => { activeSpeech = null; reject(error) })
    child.on('close', (code) => {
      activeSpeech = null
      try {
        if (code !== 0) throw new Error(stderr.trim() || `Speech process exited with code ${code}`)
        if (!existsSync(outputPath)) throw new Error('Speech engine produced no audio.')
        const audio = new Uint8Array(readFileSync(outputPath))
        resolve({ audio, mimeType: 'audio/wav', engine: 'sapi', characters: text.length })
      } catch (error) {
        reject(error)
      } finally {
        rmSync(outputPath, { force: true })
      }
    })
  })
}

function speakWithSapi(text: string, config: VoiceConfig, outputPath: string): Promise<SpokenAudio> {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SAPI_SCRIPT
  ], {
    windowsHide: true,
    env: {
      ...process.env,
      VA_TTS_TEXT: Buffer.from(text, 'utf8').toString('base64'),
      VA_TTS_OUT: outputPath,
      VA_TTS_RATE: String(config.sapiRate),
      VA_TTS_VOICE: config.sapiVoice
    }
  })
  return runSynth(child, outputPath, text)
}

function speakWithPiper(text: string, config: VoiceConfig, outputPath: string): Promise<SpokenAudio> {
  if (!existsSync(config.piperExecutable)) throw new Error(`Piper executable not found: ${config.piperExecutable}`)
  if (!existsSync(config.piperModel)) throw new Error(`Piper model not found: ${config.piperModel}`)
  const args = ['--model', config.piperModel, '--output_file', outputPath]
  if (config.piperConfig && existsSync(config.piperConfig)) args.push('--config', config.piperConfig)
  const child = spawn(config.piperExecutable, args, { windowsHide: true })
  const result = runSynth(child, outputPath, text)
  child.stdin?.end(text, 'utf8')
  return result
}

export async function speak(text: string, config: VoiceConfig = getVoiceConfig()): Promise<SpokenAudio> {
  const clean = text.trim()
  if (!clean) throw new Error('Nothing to speak.')
  if (clean.length > MAX_SPEAK_CHARS) throw new Error(`Text is too long to speak; limit is ${MAX_SPEAK_CHARS} characters.`)
  stopSpeech()
  const outputPath = join(tmpdir(), `va-voice-${randomUUID()}.wav`)
  const audio = config.ttsEngine === 'piper'
    ? await speakWithPiper(clean, config, outputPath)
    : await speakWithSapi(clean, config, outputPath)
  return { ...audio, engine: config.ttsEngine }
}

export function stopSpeech(): void {
  if (activeSpeech && !activeSpeech.killed) {
    activeSpeech.kill()
    activeSpeech = null
  }
}
