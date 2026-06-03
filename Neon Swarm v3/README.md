# Neon Swarm Online

Online Vampire Survivors tarzı HTML oyun prototipi.

## Kurulum

1. Node.js 18+ kurulu olmalı.
2. Terminali bu klasörde aç.
3. Şunu çalıştır:

```bash
npm install
npm start
```

4. Tarayıcıdan aç:

```text
http://localhost:3000
```

## Aynı bilgisayarda test

İki farklı tarayıcı sekmesi aç ve aynı oda kodunu yaz:

```text
PUBLIC
```

## Aynı Wi-Fi üzerinden test

Server çalışan bilgisayarın local IP adresini bul.

Mac için:

```bash
ipconfig getifaddr en0
```

Sonra telefondan veya başka bilgisayardan şunu aç:

```text
http://LOCAL_IP:3000
```

Örnek:

```text
http://192.168.1.23:3000
```

## Deploy

Render, Railway, Fly.io veya kendi VPS üzerinde çalıştırılabilir.

Başlatma komutu:

```bash
npm start
```

Port:

```text
process.env.PORT
```

## Online sistemde olanlar

- WebSocket multiplayer
- Oda kodu sistemi
- Birden fazla oyuncu aynı haritada
- Server authoritative enemy, XP, boss, anvil, upgrade state
- Oyuncu input'u clienttan servera gider
- Server state'i 30 FPS broadcast eder
- Level-up seçimleri oyuncu bazlıdır
- Boss ölünce geliştirme örsü düşer
- Bosslar farklı türlerde gelir
- Leaderboard vardır
- Ölünce skor karşılığı revive vardır

## Not

Bu prototip gerçek multiplayer mantığını kurar ama halen basit bir arcade prototype seviyesindedir. Daha sonra eklenebilecekler:

- Login sistemi
- Kalıcı coin / skin
- Anti-cheat geliştirme
- Lag compensation
- Matchmaking
- Private lobby linkleri
- Mobile UI polish
