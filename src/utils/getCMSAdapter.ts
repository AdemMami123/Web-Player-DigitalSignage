import { NetworkFileAdapter } from '../adapters/NetworkFileAdapter'
import { GarlicHubAdapter } from '../adapters/GarlicHubAdapter'
import { ScreenliteAdapter } from '../adapters/ScreenliteAdapter'
import { ScreenlitePlaygroundAdapter } from '../adapters/ScreenlitePlaygroundAdapter'
import type { ConfigData } from '../types/config'

export const getCMSAdapter = (adapter: string, url: string, config?: Partial<ConfigData>) => {
    if (adapter === 'NetworkFile') {
        return new NetworkFileAdapter(url)
    } else if (adapter === 'GarlicHub') {
        return new GarlicHubAdapter(url)
    } else if (adapter === 'Screenlite') {
        const backendBaseUrl = (config?.backendBaseUrl || url || '').trim()
        return new ScreenliteAdapter(backendBaseUrl, config?.defaultPairingCode || '')
    } else if (adapter === 'ScreenlitePlayground') {
        return new ScreenlitePlaygroundAdapter(url)
    } else {
        throw new Error(`Unknown CMS adapter: ${adapter}`)
    }
}
