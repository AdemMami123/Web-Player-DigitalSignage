export type PairConsumeRequest = {
    pairingCode: string
    serialNumber: string
    deviceName: string
    platform: string
    timezone: string
    telemetry: unknown
}

export type PlayerPairConsumeResponse = {
    deviceToken?: string
    token?: string
    deviceId?: string
    screenId?: string
    data?: {
        deviceToken?: string
        token?: string
        deviceId?: string
        screenId?: string
    }
}

export type PlayerTemplateElementDto = {
    type?: string
    x?: number
    y?: number
    width?: number
    height?: number
    text?: string
    imageUrl?: string
    style?: Record<string, unknown>
}

export type PlayerTemplateLayoutDto = {
    width?: number
    height?: number
    background?: string
    elements?: PlayerTemplateElementDto[]
}

export type PlayerTemplateDto = {
    screenId?: string
    templateId?: string
    name?: string
    layout?: PlayerTemplateLayoutDto
}

export type PlayerTemplateResponse =
    | PlayerTemplateDto[]
    | {
          templates?: PlayerTemplateDto[]
          data?: {
              templates?: PlayerTemplateDto[]
          }
      }

export type PlayerHeartbeatRequest = {
    screenId?: string
}

export type PlayerHeartbeatResponse = {
    online?: boolean
    status?: string
    serverTime?: string
    data?: {
        online?: boolean
        status?: string
        serverTime?: string
    }
}

export type PlayerScheduleSectionPositionDto = {
    x: number
    y: number
    width: number
    height: number
    z_index: number
}

export type PlayerScheduleItemDto = {
    id: string
    content_type: string
    content_path: string
    duration: number
}

export type PlayerScheduleSectionDto = {
    id: string
    position: PlayerScheduleSectionPositionDto
    items: PlayerScheduleItemDto[]
}

export type PlayerPlaylistDto = {
    id: string
    start_date: string
    end_date: string
    start_time: string
    end_time: string
    width: number
    height: number
    sections: PlayerScheduleSectionDto[]
}

export type PlayerScheduleResponse = {
    playlists?: PlayerPlaylistDto[]
    schedule?: {
        playlists?: PlayerPlaylistDto[]
    }
    data?: {
        playlists?: PlayerPlaylistDto[]
    }
}

export type PlayerContentSyncPayload = {
    screenId?: string
    template?: PlayerTemplateDto | null
    schedule?: PlayerScheduleResponse | PlayerPlaylistDto[] | null
    reason?: string
    recommendedClockTickMs?: number
    serverEpochMs?: number
    serverTimeZone?: string
}

export type PlayerScreenStatusPayload = {
    screenId?: string
    status?: string
    heartbeatAt?: string
    recommendedClockTickMs?: number
    serverEpochMs?: number
    serverTimeZone?: string
}

export type PlayerWsUpdateEvent = {
    type?: string
    reason?: string
    payload?: PlayerContentSyncPayload | PlayerScreenStatusPayload | null
    screenId?: string
    template?: PlayerTemplateDto | null
    schedule?: PlayerScheduleResponse | PlayerPlaylistDto[] | null
    recommendedClockTickMs?: number
    serverEpochMs?: number
    serverTimeZone?: string
}

export type ScreenliteApiResult<T> = {
    ok: boolean
    unauthorized: boolean
    data: T | null
    error: string | null
}
