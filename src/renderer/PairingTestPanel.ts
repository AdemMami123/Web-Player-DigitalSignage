import { cmsService } from '../services/cmsService'
import { configStore } from '../store/configStore'

function setButtonStyle(button: HTMLButtonElement, variant: 'primary' | 'secondary'): void {
    Object.assign(button.style, {
        padding: '9px 14px',
        borderRadius: '10px',
        border: '1px solid transparent',
        cursor: 'pointer',
        fontSize: '13px',
        fontWeight: '700',
        letterSpacing: '0.02em',
        transition: 'transform 120ms ease, filter 120ms ease, background 120ms ease, border-color 120ms ease',
    })

    if (variant === 'primary') {
        button.style.background = 'linear-gradient(135deg, #2563EB 0%, #1E40AF 100%)'
        button.style.color = '#FFFFFF'
        button.style.boxShadow = '0 10px 18px rgba(37, 99, 235, 0.35)'
    } else {
        button.style.background = 'rgba(148, 163, 184, 0.15)'
        button.style.borderColor = 'rgba(148, 163, 184, 0.35)'
        button.style.color = '#E2E8F0'
    }

    button.addEventListener('mouseenter', () => {
        button.style.transform = 'translateY(-1px)'
        button.style.filter = 'brightness(1.05)'
    })

    button.addEventListener('mouseleave', () => {
        button.style.transform = 'translateY(0)'
        button.style.filter = 'none'
    })
}

function styleInput(input: HTMLInputElement): void {
    Object.assign(input.style, {
        width: '100%',
        boxSizing: 'border-box',
        borderRadius: '10px',
        border: '1px solid rgba(148, 163, 184, 0.4)',
        background: 'rgba(2, 6, 23, 0.7)',
        color: '#F9FAFB',
        padding: '11px 12px',
        fontSize: '13px',
        outline: 'none',
        transition: 'border-color 120ms ease, box-shadow 120ms ease',
    })

    input.addEventListener('focus', () => {
        input.style.borderColor = 'rgba(96, 165, 250, 0.85)'
        input.style.boxShadow = '0 0 0 3px rgba(37, 99, 235, 0.25)'
    })

    input.addEventListener('blur', () => {
        input.style.borderColor = 'rgba(148, 163, 184, 0.4)'
        input.style.boxShadow = 'none'
    })
}

export class PairingTestPanel {
    el: HTMLDivElement
    private cardEl: HTMLDivElement
    private statusEl: HTMLParagraphElement
    private backendInput: HTMLInputElement
    private codeInput: HTMLInputElement
    private currentAdapter: string
    private currentStatus: string
    private unsubscribeConfig: (() => void) | null = null
    private unsubscribeStatus: (() => void) | null = null

    constructor() {
        this.el = document.createElement('div')
        this.cardEl = document.createElement('div')
        this.statusEl = document.createElement('p')
        this.backendInput = document.createElement('input')
        this.codeInput = document.createElement('input')
        this.currentAdapter = configStore.state.config.cmsAdapter
        this.currentStatus = cmsService.getConnectionStatus()

        this.buildDOM()

        this.unsubscribeConfig = configStore.subscribe(state => {
            this.backendInput.value = state.config.backendBaseUrl
            this.codeInput.value = state.config.defaultPairingCode
            this.currentAdapter = state.config.cmsAdapter
            this.updateVisibility()
        })

        this.unsubscribeStatus = cmsService.subscribeConnectionStatus((status) => {
            this.currentStatus = status
            this.renderStatus(status)
            this.updateVisibility()
        })
    }

    private buildDOM(): void {
        const style = document.createElement('style')
        style.textContent = `
            @keyframes pairingBackdropShift {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }
        `
        this.el.appendChild(style)

        Object.assign(this.el.style, {
            position: 'fixed',
            inset: '0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'radial-gradient(120% 90% at 50% 0%, #0B2447 0%, #030712 58%, #010204 100%)',
            backgroundSize: '180% 180%',
            animation: 'pairingBackdropShift 18s ease infinite',
            zIndex: '1001',
            padding: '20px',
            boxSizing: 'border-box',
        })

        Object.assign(this.cardEl.style, {
            width: 'min(92vw, 540px)',
            background: 'linear-gradient(165deg, rgba(15, 23, 42, 0.92) 0%, rgba(2, 6, 23, 0.97) 100%)',
            border: '1px solid rgba(148, 163, 184, 0.25)',
            borderRadius: '18px',
            padding: '22px',
            color: '#F8FAFC',
            boxShadow: '0 28px 56px rgba(0, 0, 0, 0.55)',
            backdropFilter: 'blur(5px)',
        })

        const title = document.createElement('h3')
        title.textContent = 'Screen Pairing'
        Object.assign(title.style, {
            margin: '0 0 6px 0',
            fontSize: '24px',
            fontWeight: '800',
            letterSpacing: '0.01em',
            lineHeight: '1.1',
            color: '#F8FAFC',
        })

        const subtitle = document.createElement('p')
        subtitle.textContent = 'Connect this player to your local signage backend'
        Object.assign(subtitle.style, {
            margin: '0 0 14px 0',
            fontSize: '13px',
            color: '#93C5FD',
            lineHeight: '1.45',
        })

        this.statusEl.style.margin = '0 0 16px 0'
        this.statusEl.style.fontSize = '12px'
        this.statusEl.style.fontWeight = '700'
        this.statusEl.style.padding = '8px 10px'
        this.statusEl.style.borderRadius = '10px'
        this.statusEl.style.border = '1px solid rgba(148, 163, 184, 0.35)'
        this.statusEl.style.background = 'rgba(15, 23, 42, 0.65)'

        const backendLabel = document.createElement('label')
        backendLabel.textContent = 'Backend URL'
        Object.assign(backendLabel.style, {
            display: 'block',
            marginBottom: '6px',
            fontSize: '12px',
            fontWeight: '700',
            color: '#CBD5E1',
        })

        this.backendInput.type = 'text'
        this.backendInput.placeholder = 'http://localhost:8080'
        styleInput(this.backendInput)
        this.backendInput.style.marginBottom = '12px'

        const codeLabel = document.createElement('label')
        codeLabel.textContent = 'Pairing Code'
        Object.assign(codeLabel.style, {
            display: 'block',
            marginBottom: '6px',
            fontSize: '12px',
            fontWeight: '700',
            color: '#CBD5E1',
        })

        this.codeInput.type = 'text'
        this.codeInput.placeholder = 'Enter pairing code'
        styleInput(this.codeInput)
        this.codeInput.style.marginBottom = '14px'

        const actions = document.createElement('div')
        Object.assign(actions.style, {
            display: 'flex',
            gap: '10px',
            flexWrap: 'wrap',
            marginBottom: '12px',
        })

        const applyButton = document.createElement('button')
        applyButton.type = 'button'
        applyButton.textContent = 'Apply URL'
        setButtonStyle(applyButton, 'secondary')
        applyButton.addEventListener('click', async () => {
            await configStore.updateConfig({
                backendBaseUrl: this.backendInput.value.trim(),
            })
        })

        const pairButton = document.createElement('button')
        pairButton.type = 'button'
        pairButton.textContent = 'Pair'
        setButtonStyle(pairButton, 'primary')
        pairButton.addEventListener('click', async () => {
            const backendBaseUrl = this.backendInput.value.trim()
            const pairingCode = this.codeInput.value.trim()

            await configStore.updateConfig({
                backendBaseUrl,
                defaultPairingCode: pairingCode,
            })

            const ok = await cmsService.pair(pairingCode)
            if (!ok) {
                this.renderStatus('error', 'Pair failed. Check URL/code and backend logs.')
            }
        })

        const unpairButton = document.createElement('button')
        unpairButton.type = 'button'
        unpairButton.textContent = 'Unpair'
        setButtonStyle(unpairButton, 'secondary')
        unpairButton.addEventListener('click', () => {
            cmsService.unpair()
            this.renderStatus('waiting_for_pairing', 'Device token cleared.')
        })

        actions.appendChild(applyButton)
        actions.appendChild(pairButton)
        actions.appendChild(unpairButton)

        const hint = document.createElement('p')
        hint.textContent = 'This gate remains visible until pairing is connected. Use Ctrl+S for advanced settings.'
        Object.assign(hint.style, {
            margin: '0',
            color: '#94A3B8',
            fontSize: '12px',
            lineHeight: '1.3',
        })

        this.cardEl.appendChild(title)
        this.cardEl.appendChild(subtitle)
        this.cardEl.appendChild(this.statusEl)
        this.cardEl.appendChild(backendLabel)
        this.cardEl.appendChild(this.backendInput)
        this.cardEl.appendChild(codeLabel)
        this.cardEl.appendChild(this.codeInput)
        this.cardEl.appendChild(actions)
        this.cardEl.appendChild(hint)
        this.el.appendChild(this.cardEl)

        const current = configStore.state.config

        this.backendInput.value = current.backendBaseUrl
        this.codeInput.value = current.defaultPairingCode
        this.currentAdapter = current.cmsAdapter
        this.renderStatus(this.currentStatus)
        this.updateVisibility()
    }

    private renderStatus(status: string, message?: string): void {
        const normalized = status.replace(/_/g, ' ')
        this.statusEl.textContent = `Status: ${normalized}${message ? ` - ${message}` : ''}`

        if (status === 'connected') {
            this.statusEl.style.color = '#86EFAC'
            this.statusEl.style.borderColor = 'rgba(74, 222, 128, 0.45)'
            this.statusEl.style.background = 'rgba(20, 83, 45, 0.35)'
            return
        }

        if (status === 'offline' || status === 'error' || status === 'unauthorized') {
            this.statusEl.style.color = '#FCA5A5'
            this.statusEl.style.borderColor = 'rgba(248, 113, 113, 0.45)'
            this.statusEl.style.background = 'rgba(127, 29, 29, 0.32)'
            return
        }

        this.statusEl.style.color = '#D1D5DB'
        this.statusEl.style.borderColor = 'rgba(148, 163, 184, 0.35)'
        this.statusEl.style.background = 'rgba(15, 23, 42, 0.65)'
    }

    private updateVisibility(): void {
        if (this.currentAdapter !== 'Screenlite') {
            this.el.style.display = 'none'
            return
        }

        this.el.style.display = this.currentStatus === 'connected' ? 'none' : 'flex'
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.el)
    }

    destroy(): void {
        this.unsubscribeConfig?.()
        this.unsubscribeStatus?.()
        this.el.remove()
    }
}
