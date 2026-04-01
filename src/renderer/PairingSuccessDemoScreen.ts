export class PairingSuccessDemoScreen {
    el: HTMLDivElement
    private timeEl: HTMLSpanElement

    constructor() {
        this.el = document.createElement('div')
        this.timeEl = document.createElement('span')
        this.buildDOM()
    }

    private buildDOM(): void {
        Object.assign(this.el.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '40',
            background: 'linear-gradient(160deg, #0f172a 0%, #052e16 45%, #111827 100%)',
            color: '#F8FAFC',
            fontFamily: 'Trebuchet MS, Segoe UI, sans-serif',
            display: 'none',
            overflow: 'hidden',
        })

        const style = document.createElement('style')
        style.textContent = `
            @keyframes menuTickerSwipe {
                0% { transform: translateX(0); }
                100% { transform: translateX(-50%); }
            }
            @keyframes menuPulse {
                0%, 100% { opacity: 0.84; }
                50% { opacity: 1; }
            }
        `
        this.el.appendChild(style)

        const header = document.createElement('div')
        Object.assign(header.style, {
            padding: '22px 28px 14px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
        })

        const brandWrap = document.createElement('div')
        const title = document.createElement('h1')
        title.textContent = 'Pairing Success Test Menu'
        Object.assign(title.style, {
            margin: '0',
            fontSize: '38px',
            letterSpacing: '0.04em',
            lineHeight: '1.1',
        })

        const subtitle = document.createElement('p')
        subtitle.textContent = 'Restaurant-style signage preview for validation'
        Object.assign(subtitle.style, {
            margin: '8px 0 0',
            color: '#BFDBFE',
            fontSize: '16px',
        })

        brandWrap.appendChild(title)
        brandWrap.appendChild(subtitle)

        const nowWrap = document.createElement('div')
        Object.assign(nowWrap.style, {
            background: 'rgba(15, 23, 42, 0.7)',
            border: '1px solid rgba(191, 219, 254, 0.25)',
            borderRadius: '10px',
            padding: '10px 14px',
            fontSize: '14px',
            color: '#E2E8F0',
            animation: 'menuPulse 3.2s ease-in-out infinite',
        })
        nowWrap.textContent = 'Now: '
        nowWrap.appendChild(this.timeEl)

        header.appendChild(brandWrap)
        header.appendChild(nowWrap)

        const grid = document.createElement('div')
        Object.assign(grid.style, {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: '14px',
            padding: '0 28px 14px',
            boxSizing: 'border-box',
        })

        const cards = [
            {
                title: 'Breakfast',
                accent: '#F59E0B',
                rows: ['Avocado Toast - $8.50', 'Shakshuka Plate - $11.00', 'French Omelet - $9.20', 'Granola Bowl - $7.10'],
            },
            {
                title: 'Lunch',
                accent: '#22C55E',
                rows: ['Smash Burger - $12.90', 'Roast Chicken Wrap - $10.40', 'Pesto Pasta - $13.60', 'Falafel Bowl - $11.80'],
            },
            {
                title: 'Drinks',
                accent: '#38BDF8',
                rows: ['Cold Brew - $4.20', 'Iced Matcha - $5.00', 'Fresh Lemonade - $3.80', 'Sparkling Mint - $4.10'],
            },
        ]

        for (const card of cards) {
            grid.appendChild(this.createMenuCard(card.title, card.rows, card.accent))
        }

        const tickerWrap = document.createElement('div')
        Object.assign(tickerWrap.style, {
            position: 'absolute',
            left: '0',
            right: '0',
            bottom: '0',
            overflow: 'hidden',
            background: 'rgba(2, 6, 23, 0.92)',
            borderTop: '1px solid rgba(186, 230, 253, 0.22)',
            whiteSpace: 'nowrap',
        })

        const tickerTrack = document.createElement('div')
        Object.assign(tickerTrack.style, {
            display: 'inline-flex',
            width: 'max-content',
            minWidth: '200%',
            animation: 'menuTickerSwipe 22s linear infinite',
            padding: '10px 0',
            fontSize: '26px',
            color: '#FDE68A',
            letterSpacing: '0.03em',
            fontWeight: '700',
            textTransform: 'uppercase',
        })

        const tickerText = 'Today: buy 2 burgers get 1 soda free | New combo menu available | Happy hour 5PM - 7PM | '
        tickerTrack.textContent = `${tickerText}${tickerText}${tickerText}`

        tickerWrap.appendChild(tickerTrack)

        this.el.appendChild(header)
        this.el.appendChild(grid)
        this.el.appendChild(tickerWrap)
    }

    private createMenuCard(title: string, rows: string[], accent: string): HTMLElement {
        const card = document.createElement('section')
        Object.assign(card.style, {
            background: 'rgba(15, 23, 42, 0.72)',
            border: `1px solid ${accent}`,
            borderRadius: '14px',
            padding: '12px 14px',
            minHeight: '320px',
            boxShadow: '0 12px 28px rgba(2, 6, 23, 0.4)',
        })

        const heading = document.createElement('h2')
        heading.textContent = title
        Object.assign(heading.style, {
            margin: '0 0 12px',
            color: accent,
            fontSize: '28px',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
        })

        card.appendChild(heading)

        for (const rowText of rows) {
            const row = document.createElement('p')
            row.textContent = rowText
            Object.assign(row.style, {
                margin: '8px 0',
                fontSize: '20px',
                lineHeight: '1.3',
                color: '#E2E8F0',
            })
            card.appendChild(row)
        }

        return card
    }

    updateTime(timestamp: number): void {
        this.timeEl.textContent = new Date(timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        })
    }

    show(): void {
        this.el.style.display = 'block'
    }

    hide(): void {
        this.el.style.display = 'none'
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.el)
    }

    destroy(): void {
        this.el.remove()
    }
}
