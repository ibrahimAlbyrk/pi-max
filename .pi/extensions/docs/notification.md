# Notification Extension

Agent isini bitirdiginde veya hata olustugunda ses ve isletim sistemi bildirimleri gonderen extension.

## Kurulum

`.pi/extensions/notification/` dizini `.pi/extensions/` altinda bulunmalidir. Otomatik yuklenir.

## Kullanim

### Komut

```
/notify              # Durum goster
/notify on           # Bildirimleri ac
/notify off          # Bildirimleri kapat
/notify sound on     # Ses bildirimlerini ac
/notify sound off    # Ses bildirimlerini kapat
/notify os on        # OS bildirimlerini ac
/notify os off       # OS bildirimlerini kapat
/notify test         # Test bildirimi gonder
```

## Ozellikler

- **Platform destegi**: macOS ve Linux
- **Ses bildirimleri**: Agent tamamlandiginda veya hata olustugunda ses calar
- **OS bildirimleri**: Isletim sistemi bildirim merkezi uzerinden bildirim
- **Fallback**: Ses calamazsa terminal bell kullanir
- **Arac ozeti**: Kullanilan tool sayisini bildirimde gosterir
- **Kalici ayarlar**: Bildirim tercihleri oturum verileriyle saklanir

## Platform Detaylari

### macOS

| Islem | Komut |
|-------|-------|
| Ses | `afplay` |
| OS bildirimi | `osascript` (AppleScript) |

### Linux

| Islem | Komut |
|-------|-------|
| Ses | `paplay` veya `aplay` |
| OS bildirimi | `notify-send` |

## Ses Tipleri

| Tip | Ne zaman |
|-----|----------|
| `complete` | Agent basariyla tamamlandiginda |
| `error` | Hata olustugunda |

## Hook'lar

| Hook | Islem |
|------|-------|
| `agent_start` | Zamanlayiciyi baslatir |
| `agent_end` | Bildirim gonderir |
| `tool_call` | Tool cagrisi sayacini arttirir |

## Faydalar

- Uzun sureli agent calismalari sirasinda baska islerle ilgilenebilirsiniz
- Agent bittiginde sesli/gorsel uyari alirsiniz
- Hata durumlarini aninda fark edebilirsiniz
- Ses ve OS bildirimlerini bagimsiz olarak kontrol edebilirsiniz
