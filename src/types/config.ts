export interface ConfigData {
    cmsAdapter: string
    cmsAdapterUrl: string
    backendBaseUrl: string
    defaultPairingCode: string
    timezone: string
    playbackTrackerEnabled: boolean
}

export interface ConfigStorageAdapter {
    get(): Promise<ConfigData>
    set(config: Partial<ConfigData>): Promise<void>
    clear(): Promise<void>
}

export type ConfigOverlayProps = {
    isOpen: boolean
    onClose: () => void
} 