# Background Process Extension

Uzun sureli arka plan islemlerini (sunucular, watcher'lar, build gorevleri) yonetmenizi saglayan extension.

## Kurulum

`.pi/extensions/background-process/` dizini `.pi/extensions/` altinda bulunmalidir. Otomatik yuklenir.

## Kullanim

### Tool (Agent tarafindan)

```
bg run "npm run dev" --name devserver
bg stop devserver
bg list
bg logs devserver --lines 100
bg restart devserver
```

### Komutlar (Kullanici tarafindan)

| Komut | Islem |
|-------|-------|
| `/bg` | Calisanlari listele |
| `/bg stop <isim>` | Belirtilen islemi durdur |
| `/bg stopall` | Tum islemleri durdur |
| `/bg clean` | Durmus islemleri temizle |

### Kisayol

| Tus | Islem |
|-----|-------|
| `Shift+Down` | Islem panelini ac |

## Ozellikler

- **Islem yonetimi**: `run`, `stop`, `list`, `logs`, `restart` aksiyonlari
- **Ring buffer**: Her islem icin son 500 satir cikti saklanir
- **Graceful shutdown**: SIGTERM → 5 saniye bekleme → SIGKILL
- **Durum takibi**: running / stopped / crashed durumlari
- **Task baglama**: Arka plan islemi bir task ID ile iliskilendirilebilir
- **Animasyonlu badge**: Calistirilan islem sayisini parlayan efektle gosterir
- **Interaktif panel**: Detayli islem gorunumu

## Tool Parametreleri

### `bg run`

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `command` | string | Evet | Calistirilacak komut |
| `name` | string | Hayir | Islem adi (otomatik turetilir) |
| `cwd` | string | Hayir | Calisma dizini |
| `taskId` | number | Hayir | Iliskilendirilen task ID |

### `bg logs`

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `name` | string | Evet | Islem adi |
| `lines` | number | Hayir | Son N satir (varsayilan: 50) |

## Event'ler

| Event | Aciklama |
|-------|----------|
| `bg:started` | Islem basladiginda |
| `bg:stopped` | Islem durdurulanda |
| `bg:crashed` | Islem beklenmedik sekilde sonlandiginda |
| `bg:ready` | Islem hazir oldugunda |

## Faydalar

- Dev sunucularini pi icerisinden baslatip yonetebilirsiniz
- Build watcher'lari arka planda calistirabilirsiniz
- Task tamamlandiginda iliskili islemler otomatik durdurulur
- Islem loglarini pi icerisinden gorebilirsiniz
