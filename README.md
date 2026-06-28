# Gujarati OCR Bot 🤖

Telegram bot jo Gujarati MCQ PDF se questions extract karta hai.

## Setup

### 1. GitHub Repo Banao
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/gujarati-ocr-bot.git
git push -u origin main
```

### 2. Render pr Deploy Karo
1. [render.com](https://render.com) pe login karo
2. **New → Web Service** click karo
3. GitHub repo connect karo
4. Settings:
   - **Build Command:** `cd api-server && npm install && npm run build`
   - **Start Command:** `cd api-server && npm start`
   - **Region:** Singapore (India ke liye fast)
5. **Environment Variables** mein ye set karo:
   - `TELEGRAM_BOT_TOKEN` = apna bot token
   - `AICREDITS_API_KEY` = aicredits.in ka API key
   - `PORT` = `10000`

### 3. Deploy!
Render automatically deploy karega. Bot 1-2 min mein live ho jayega.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | @BotFather se liya hua token |
| `AICREDITS_API_KEY` | aicredits.in ka API key |
| `PORT` | Server port (Render pe 10000) |

## Notes
- Free tier pe Render service 15 min baad sleep ho jaati hai
- Keep-alive pinger har 14 min pe ping karta hai taaki service jaag rahe
