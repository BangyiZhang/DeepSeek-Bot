export interface SettingsLink { id: string; label: string; value?: string }

export interface SettingsFormProps {
  dark: boolean
  accent: string
  ink: string
  ink2: string
  phone: SettingsLink[]
  team: SettingsLink[]
  theme: string
  themes: { id: string; label: string }[]
  lang: string
  langs: { id: string; label: string }[]
  banners: boolean
  labels: { phone: string; team: string; appearance: string; language: string; banners: string }
  onTheme: (id: string) => void
  onLang: (id: string) => void
  onBanners: (on: boolean) => void
  onOpen: (id: string) => void
}
