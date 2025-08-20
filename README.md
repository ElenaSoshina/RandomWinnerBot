Random Winner Bot

Небольшой Telegram-бот на Node.js для проведения розыгрышей в канале и случайного выбора победителя. Поддерживает запуск в Docker. В дальнейшем можно интегрировать MProxy-клиент (через переменные прокси).

Локальный запуск

1. Создайте файл `.env` в корне проекта со следующим содержимым и укажите токен бота:
   ```
   BOT_TOKEN=1234567890:replace_with_your_token
   LOG_LEVEL=info
   # Необязательно: прокси (http/https/socks)
   # HTTPS_PROXY=http://user:pass@host:port
   # ALL_PROXY=socks5://user:pass@host:port
   ```
2. Установите зависимости и запустите:
   ```bash
   npm ci
   npm run dev
   ```

Запуск в Docker

- Сборка и запуск:
  ```bash
  docker compose up -d --build
  ```
- Логи:
  ```bash
  docker logs -f random-winner-bot
  ```

Переменные окружения
- `BOT_TOKEN` — токен Telegram-бота (обязательно)
- `LOG_LEVEL` — уровень логирования (`info`, `debug`, ...)
- `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` — опционально, прокси (http/https/socks5)

Деплой на сервер

1. Скопируйте репозиторий на сервер (или используйте `git clone`).
2. Создайте `.env` с вашим токеном.
3. Установите Docker и Docker Compose.
4. Запустите:
   ```bash
   docker compose up -d --build
   ```

Команды бота
- `/start` — приветственное сообщение
- `/ping` — проверка доступности

Дальнейшие шаги
- Получение участников канала и выбор победителя
- Интеграция с MProxy
- Хранение состояния розыгрыша (например, Redis/Postgres)


