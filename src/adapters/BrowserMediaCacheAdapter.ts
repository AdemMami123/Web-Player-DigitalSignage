import type { MediaItem } from '../types/cache'

export interface MediaCacheAdapter {
    cacheMedia: (items: MediaItem[], signal?: AbortSignal) => Promise<Map<string, boolean>>
    getMediaUrl: (url: string) => Promise<string | null>
    clearCache: () => Promise<void>
    removeUnusedMedia: (currentUrls: string[]) => Promise<void>
}

export class BrowserMediaCacheAdapter implements MediaCacheAdapter {
    private cache: Cache | null = null
    private CACHE_NAME = 'media-cache-v1'

    constructor() {
        this.initCache()
    }

    private async initCache() {
        if ('caches' in window) {
            this.cache = await caches.open(this.CACHE_NAME)
        }
    }

    private toCacheRequest(url: string): Request | null {
        try {
            const parsed = new URL(url, window.location.href)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return null
            }
            return new Request(parsed.toString(), { method: 'GET' })
        } catch {
            return null
        }
    }

    private isInlineMediaUrl(url: string): boolean {
        return url.startsWith('data:') || url.startsWith('blob:')
    }

    async cacheMedia(items: MediaItem[], signal?: AbortSignal): Promise<Map<string, boolean>> {
        if (!this.cache) {
            throw new Error('Cache not available')
        }

        const results = new Map<string, boolean>()

        for (const item of items) {
            if (signal?.aborted) {
                break
            }

            try {
                const url = String(item.url ?? '')
                if (!url) {
                    results.set(item.url, false)
                    continue
                }

                if (this.isInlineMediaUrl(url)) {
                    // Inline media is already self-contained and should not be persisted via Cache API.
                    results.set(url, true)
                    continue
                }

                const request = this.toCacheRequest(url)
                if (!request) {
                    // Unsupported schemes (for example file:) are treated as non-cacheable but usable.
                    results.set(url, true)
                    continue
                }

                const response = await fetch(request, { signal })
                if (response.ok) {
                    await this.cache.put(request, response.clone())
                    results.set(url, true)
                } else {
                    results.set(url, false)
                }
            } catch (error) {
                results.set(item.url, false)
                console.error(`Failed to cache ${item.url}:`, error)
            }
        }

        return results
    }

    async getMediaUrl(url: string): Promise<string | null> {
        if (!this.cache) {
            return null
        }

        if (this.isInlineMediaUrl(url)) {
            return url
        }

        const request = this.toCacheRequest(url)
        if (!request) {
            return url
        }

        const response = await this.cache.match(request)
        if (response) {
            return url
        }
        return null
    }

    async clearCache(): Promise<void> {
        if ('caches' in window) {
            await caches.delete(this.CACHE_NAME)
            this.cache = await caches.open(this.CACHE_NAME)
        }
    }

    async removeUnusedMedia(currentUrls: string[]): Promise<void> {
        if (!this.cache) {
            return
        }

        const urlSet = new Set(
            currentUrls
                .map(url => this.toCacheRequest(url)?.url)
                .filter((value): value is string => Boolean(value))
        )
        const keys = await this.cache.keys()
        
        for (const request of keys) {
            if (!urlSet.has(request.url)) {
                await this.cache.delete(request)
            }
        }
    }
} 