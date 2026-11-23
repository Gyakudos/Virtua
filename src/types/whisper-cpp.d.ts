declare module 'whisper.cpp' {
  interface WhisperModule {
    ready: Promise<unknown>
    FS_createDataFile(
      parent: string,
      name: string,
      data: Uint8Array,
      canRead: boolean,
      canWrite: boolean,
      canOwn: boolean
    ): void
    init(path: string): boolean
    free(): void
    full_default(audio: Float32Array, language: string, translate: boolean): number
  }

  interface WhisperOverrides {
    print?: (line: string) => void
    printErr?: (line: string) => void
  }

  export default function whisperFactory(overrides?: WhisperOverrides): Promise<WhisperModule>
}
