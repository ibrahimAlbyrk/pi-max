# Image Markers Extension

Gorsel dosya yollarini temiz `[Image #N]` isaretleyicilere donusturur ve otomatik olarak mesaja gomuler.

## Kurulum

`.pi/extensions/image-markers.ts` konumuna yerlestirin. Otomatik yuklenir.

## Kullanim

1. Panodan bir gorsel yapistirin
2. Editorde `[Image #1]` isaretleyicisi otomatik olusur
3. Mesaj gonderildiginde gorsel base64 olarak mesaja gomulur

## Ozellikler

- **Pano destegi**: Kopyalanan gorselleri dogrudan yapistirabilirsiniz
- **Otomatik numaralama**: `[Image #1]`, `[Image #2]` seklinde siralanir
- **Base64 gomme**: Gonderim sirasinda gorseller otomatik olarak mesaja eklenir
- **Gorsel widget'i**: Editorun altinda ekli gorsellerin tiklanabilir linkleri gosterilir (⌘+Click)
- **Kalici depolama**: Gorseller `/tmp/pi-images/` dizininde MD5 hash ile saklanir
- **OSC 8 hyperlink**: Terminal icerisinde gorselleri acmak icin tiklanabilir linkler
- **Otomatik senkronizasyon**: Editor metniyle gorsel referanslarini otomatik esler

## Calisma Prensibi

```
Kullanici gorseli yapistirir
    ↓
/tmp/pi-images/<md5>.png olarak kaydedilir
    ↓
Editorde [Image #1] gosterilir
    ↓
Widget'ta onizleme linki gosterilir
    ↓
Mesaj gonderildiginde base64 olarak user mesajina gomulur
```

## Hook'lar

| Hook | Islem |
|------|-------|
| `input` | Gorsel yollarini base64 icerigi ile degistirir |
| `session_start` | Widget'i baslatir |
| `session_before_switch` | Oturum degistiginde temizler |
| `session_shutdown` | Kaynaklari temizler |

## Faydalar

- Gorselleri dogrudan editore yapistirabileceginiz icin dosya yollariyla ugrasmak gerekmez
- LLM'e gorsel gondermek icin ek arac kullanmaniza gerek kalmaz
- Birden fazla gorsel ile calismayi kolaylastirir
