# Prompt History Search Extension

Gecmis oturumlardaki tum prompt'lari arayip yeniden kullanmanizi saglar.

## Kurulum

`.pi/extensions/prompt-history-search.ts` konumuna yerlestirin. Otomatik yuklenir.

## Kullanim

| Erisim | Yontem |
|--------|--------|
| Klavye kisayolu | `Alt+R` |
| Komut | `/history` |

## Ozellikler

- **Fuzzy arama**: Birden fazla kelime ile eslesme destegi
- **Deduplication**: Ayni prompt'larin tekrar gosterilmesini onler (`originalCommand` veya metin icerigi uzerinden)
- **Zamana gore siralama**: En yeni prompt'lar en ustte
- **Artimsal cache**: Dosya degisiklik zamani (mtime) bazli guncellenme
- **Aktif oturum destegi**: Mevcut oturumun prompt'lari bellekten okunur (disk I/O yok)
- **Limit**: Maksimum 1000 prompt cache'lenir

## Calisma Prensibi

```
Alt+R basilir
    ↓
Tum oturum dosyalari taranir (cache ile)
    ↓
Fuzzy arama arayuzu acilir
    ↓
Kullanici arama yapar
    ↓
Secilen prompt editore yazilir
```

## Arama

- Yazdiginiz her kelime ayri ayri eslenir
- Tum kelimelerin eslesmesi gerekir (AND mantigi)
- Buyuk/kucuk harf duyarsiz

## Faydalar

- Onceki oturumlarda kullandiginiz prompt'lari hizlica bulabilirsiniz
- Karmasik prompt'lari tekrar yazmak yerine aramayla bulup yeniden kullanabilirsiniz
- Oturumlar arasi prompt paylasiminii kolaylastirir
