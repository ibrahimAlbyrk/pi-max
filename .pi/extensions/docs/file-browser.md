# File Browser Extension

Proje dosyalarini gorsel olarak gezmenizi ve referans olarak eklemenizi saglayan dosya tarayici.

## Kurulum

`.pi/extensions/file-browser.ts` konumuna yerlestirin. Otomatik yuklenir.

## Kullanim

| Erisim | Yontem |
|--------|--------|
| Klavye kisayolu | `Alt+O` |
| Komut | `/browse` |

## Ozellikler

- **Coklu secim**: ☑/☐ onay kutulariyla birden fazla dosya secimi
- **Arama/filtreleme**: `/` tusuyla fuzzy arama modu
- **Dizin gezinme**: Klasorler arasi ileri-geri navigasyon
- **Panoya kopyalama**: `c` tusuyla secili dosya yollarini kopyalar
- **Dosya boyutu gosterimi**: Her dosyanin boyutunu gosterir
- **Gizli dosya destegi**: `h` tusuyla gizli dosyalari goster/gizle
- **Toplu secim**: `a` tusuyla tum dosyalari sec/kaldir

## Tuslar

| Tus | Islem |
|-----|-------|
| ↑/↓ | Dosyalar arasi gezinme |
| Enter | Dizine gir / dosya sec |
| Backspace | Ust dizine don |
| Space | Dosya sec/kaldir |
| `/` | Arama modunu ac |
| `c` | Secilenleri panoya kopyala |
| `h` | Gizli dosyalari goster/gizle |
| `a` | Tumunu sec/kaldir |
| `o` | Secilenleri editore ekle |
| Escape | Kapat |

## Cikti

Secilen dosyalar iki sekilde kullanilabilir:

1. **Editor**: `@dosya/yolu` formatinda editore yapistirma
2. **Clipboard**: Dosya yollarini panoya kopyalama

## Faydalar

- Dosya yollarini elle yazmak yerine gorsel olarak secebilirsiniz
- Coklu dosya referansi olusturmayi kolaylastirir
- Fuzzy arama ile buyuk projelerde hizlica dosya bulabilirsiniz
