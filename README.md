# Screenlite Player Web

An open-source, web-based digital signage player.

Built with **Vite** and **TypeScript**. No framework — direct DOM rendering with a vanilla TS architecture.

## Getting Started

1. **Clone the repository:**
	```bash
	git clone https://github.com/screenlite/web-player.git
	cd web-player
	```

2. **Install dependencies:**
	```bash
	bun install
	```

3. **Start the development server:**
	```bash
	bun run dev
	```

## Supported Data Sources

- **Network JSON file**
- **[Screenlite CMS](https://github.com/screenlite/screenlite)** _(HTTP-based pairing flow)_
- **[Garlic-Hub CMS](https://github.com/sagiadinos/garlic-hub)** _(Work in Progress)_

## Recent Changes & Features

### 🔐 Screenlite Pairing-First Architecture
- Full HTTP-based CMS adapter implementation with device pairing
- Pairing gate enforced before playback begins
- Device token management via localStorage
- Automatic heartbeat polling to maintain device connection

### 📱 Multi-Screen Support
- Single device can be paired to multiple screens
- Optional `screenId` parameter in heartbeat and schedule requests
- Backward compatibility with fallback behavior for devices without screenId
- Seamless device-to-screen assignment from Screenlite backend

### 🎨 Enhanced UI/UX
- Modern glassmorphic design for pairing panel
- Real-time connection status indicators with color-coded badges
- Smooth animations and transitions
- Focus and hover states for better accessibility
- Restaurant-style demo screen displayed on successful pairing with empty schedule

### 🔄 Connection Management
- Multi-listener subscription pattern for connection status
- Independent subscribers (PairingTestPanel, ConfigOverlay, etc.)
- Real-time connection state broadcasting
- Automatic retry logic with exponential backoff

### 🧹 Cache & State Management
- Automatic cache cleanup on startup for legacy content
- localStorage-backed state persistence (token, device info, config)
- Reactive configuration store
- Environment-based defaults

### Backend Integration (Screenlite)
- **POST /api/player/pair/consume** — Device pairing with code exchange
- **POST /api/player/heartbeat** — Keep-alive with optional screenId
- **GET /api/player/schedule** — Fetch playlists (supports ?screenId= query)
- **X-Device-Token** header authentication
- Device telemetry collection (serial, resolution, OS, etc.)

## Configuration

### Environment Variables
```env
VITE_CMS_ADAPTER=Screenlite          # Default CMS adapter
VITE_BACKEND_BASE_URL=http://localhost:8080  # Screenlite backend URL
```

### Local Storage (Persisted)
```js
{
  deviceToken: string,               // Authorization token from pair
  linkedDevice: {
    deviceId: string,
    screenId: string                 // Optional: specific screen assignment
  },
  cmsAdapter: "Screenlite",
  backendBaseUrl: "http://...",
  pairingCode: string,
  timezone: string
}
```

## Project Structure

```
src/
  adapters/
    ScreenliteAdapter.ts            # HTTP-based Screenlite CMS
    GarlicHubAdapter.ts
    NetworkFileAdapter.ts
    BrowserMediaCacheAdapter.ts
  renderer/
    PairingTestPanel.ts             # Pairing input UI
    PairingSuccessDemoScreen.ts      # Demo screen post-pairing
    Player.ts                        # Main playlist renderer
    PlaylistRenderer.ts              # Playlist layout
  services/
    cmsService.ts                   # CMS lifecycle & subscriptions
    cacheService.ts                 # Media caching
  config/
    defaults.ts                     # Default configuration
  types/
    config.ts                       # Configuration types
    cache.ts                        # Cache types
  utils/
    parseSmil.ts                    # SMIL parsing
    getActivePlaylist.ts            # Playlist selection logic
```

## Development Workflow

1. **Configuration Flow:**
   - User selects CMS adapter (defaults to Screenlite)
   - Enters backend URL and pairing code
   - Pairing panel appears until connection succeeds

2. **Pairing Flow:**
   - Device sends pairing code to backend
   - Backend returns deviceToken and screenId
   - Token stored in localStorage for future sessions
   - Heartbeat polls server every 30s to maintain connection

3. **Schedule Polling:**
   - Player fetches playlist schedule from backend
   - If screenId exists, requests screen-specific playlists
   - Falls back to all-screens playlists if no screenId
   - Automatically processes and renders schedule

4. **Playback:**
   - Player renders active playlist
   - Handles media transitions, timing, and layout
   - Supports gapless playback for seamless transitions

## API Response Formats

### Pairing Response
```json
{
  "deviceToken": "jwt-token-here",
  "deviceId": "device-001",
  "screenId": "screen-123",
  "expiresAt": "2026-04-02T12:00:00Z"
}
```

### Schedule Response
```json
{
  "playlists": [
    {
      "id": "playlist-1",
      "name": "Main Display",
      "items": [...]
    }
  ],
  "schedules": [
    {
      "startTime": "09:00",
      "endTime": "17:00",
      "playlistId": "playlist-1"
    }
  ]
}
```

## Notes

- If you encounter CORS errors, you can launch Chrome with web security disabled:

	**On Linux/macOS:**
	```bash
	chrome --disable-web-security --user-data-dir="/tmp/chrome"
	```

	**On Windows:**
	```powershell
	start chrome --disable-web-security --user-data-dir="C:\chrome-dev"
	```
- This project is tested and intended for use in **Google Chrome** only.
- For production use, ensure your Screenlite backend is properly configured with HTTPS and CORS headers.
