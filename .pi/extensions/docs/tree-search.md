# Tree Search Extension

Token verimli proje dosya tarama ve arama araci. .gitignore kurallarina uyar.

## Kurulum

`.pi/extensions/tree-search/` dizini `.pi/extensions/` altinda bulunmalidir. Otomatik yuklenir.

## Kullanim

Agent tarafindan tool olarak kullanilir:

```
tree_search()                              # Ust duzey genel bakis
tree_search(path="src", depth=1)           # src/ icerigini goster
tree_search(path="src", type="dir")        # Sadece alt dizinler
tree_search(query="input system")          # Fuzzy arama
tree_search(query="/auth.*middleware/")     # Regex arama
tree_search(content="handleAuth")          # Dosya iceriginde arama
tree_search(content="TODO", path="src")    # Kapsamli icerik arama
tree_search(query="config", offset=50)     # Sonuclari sayfalama
```

## Uc Mod

### 1. Gozatma Modu (Browse)

`query` ve `content` parametresi olmadan kullanilir. Dizin agacini katman katman gosterir.

| Parametre | Tip | Varsayilan | Aciklama |
|-----------|-----|-----------|----------|
| `path` | string | proje koku | Baslangic dizini |
| `depth` | number | 1 | Gosterilecek derinlik |
| `type` | "file" / "dir" | - | Filtre |
| `limit` | number | 100 | Maksimum sonuc |
| `offset` | number | 0 | Sayfalama icin atlama |

### 2. Arama Modu (Search)

`query` parametresi ile dosya yollarinda arama yapar.

| Arama Tipi | Sozdizimi | Ornek |
|------------|-----------|-------|
| Fuzzy | Duz metin | `query="input system"` |
| Regex | `/desen/` | `query="/auth.*middleware/"` |

Fuzzy eslestirme ozellikleri:
- Kelime siniri eslesmesi odullendirilir
- camelCase gecisleri desteklenir
- Ardisik eslesmelere yuksek puan
- Kisa yollar tercih edilir

### 3. Icerik Modu (Content)

`content` parametresi ile dosya iceriklerinde arama yapar. Ripgrep veya grep kullanir.

```
tree_search(content="handleAuth")           # Tum projede
tree_search(content="TODO", path="src")     # Belirli dizinde
```

## Tool Parametreleri

| Parametre | Tip | Aciklama |
|-----------|-----|----------|
| `path` | string | Gozatma koku |
| `depth` | number | Derinlik seviyesi |
| `query` | string | Dosya yolu arama sorgusu |
| `content` | string | Dosya icerigi arama sorgusu |
| `type` | "file" / "dir" | Sonuc filtresi |
| `offset` | number | Sayfalama offset'i |
| `limit` | number | Maksimum sonuc sayisi |

## Varsayilan Limitler

| Mod | Limit |
|-----|-------|
| Browse | 100 |
| Search | 50 |
| Content | 50 |

## Cache Sistemi

- **Duz indeks**: Tum dosya yollarini bellekte tutar
- **LRU browse cache**: 500 kayit, 30 saniyelik TTL
- **Arka plan tarama**: Debounce ile yeniden indeksleme
- **Dosya izleme**: Degisikliklerde cache otomatik gecersizlesir

## Faydalar

- `grep` ve `find`'a gore cok daha az token tuketir
- Buyuk projelerde hizli dosya kesfetme saglar
- .gitignore'a uyarak gereksiz dosyalari atlar
- Fuzzy arama ile tam yol bilmeden dosya bulabilirsiniz
- Icerik arama ile ripgrep hizinda kod arama yapabilirsiniz
