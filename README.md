# NaijaBiz AI Backend API

NaijaBiz AI helps Nigerian shop owners and market traders run their business by talking to it.
A trader can say "I bought 50 bags of rice for 4 million naira", photograph a supplier invoice,
or type a message, and the app records it after they confirm.

This repository is the backend: the database, the business rules and the REST API that the
mobile app uses. Speech recognition and language understanding live in a separate ML service,
which this backend calls over HTTP.

Built with Node.js, Express, MongoDB (Mongoose), JWT authentication and Swagger (OpenAPI 3).

## What the backend does

- **Nothing is saved until the trader confirms.** Voice, receipt and text inputs become a
  proposed action. The trader can confirm it, edit it or cancel it. Every proposal is kept as an
  audit record.
- **Inventory.** Sales take stock out and purchases put it back. Damaged and expired goods can be
  written off. Stock can never go below zero, and current stock always equals the sum of its
  recorded movements.
- **Money.** Sales, purchases and expenses, profit and loss, a cash flow view and the
  dashboard totals all come from the same records, so the figures agree.
- **Customer debts.** A ledger with ageing (under 7 days, 8-14, 15-30 and over 30 days) and
  reminder messages in English, Yoruba, Hausa and Igbo.
- **Alerts.** An hourly check for low stock, items that will run out soon, falling sales, rising
  expenses, overdue debts and weekend demand.
- **Ask My Business.** Plain answers to questions such as "How much rice do I have left?" or
  "Can I afford a freezer?".
- **Four languages.** English (`en`), Yoruba (`yo`), Hausa (`ha`) and Igbo (`ig`).

If the ML service is down, the backend falls back to its own simpler parser so the app keeps
working.

## Getting started

You need Node.js 20 or newer and a MongoDB database that supports transactions (MongoDB Atlas
or any replica set).

```bash
npm install
```

Create a `.env` file in the project root (it is ignored by git; never commit it):

```env
PORT=5000
MONGODB_URI=<your MongoDB Atlas connection string>
JWT_SECRET=<a long random value>
```

To generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Start the server:

```bash
npm run dev     # restarts on file changes
npm start       # plain start
```

The API runs at `http://localhost:5000`, with interactive docs at `http://localhost:5000/api-docs`.

The first time the server starts on an empty database, it loads a demo provisions shop (products,
customers, three weeks of sales, expenses and debts). Log in with phone `08023456789` and password
`password123`. To reset the database back to the demo shop at any time, run `npm run seed`. This
deletes everything in the database, so never run it against real data.

### Checking the database connection

Open `http://localhost:5000/health`. If it shows `"databaseType": "in-memory"`, the server could
not reach `MONGODB_URI` and is running on a temporary database that is wiped on restart. With Atlas,
this usually means your IP address is not on the Atlas network access list.

## Environment variables

Only `MONGODB_URI` and `JWT_SECRET` are needed to run locally. Everything else has a sensible default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5000` | Port the server listens on |
| `NODE_ENV` | `development` | Set to `production` when deployed |
| `MONGODB_URI` | | MongoDB connection string (Atlas or a replica set) |
| `JWT_SECRET` | | Signs access tokens. Required in production, at least 32 characters |
| `JWT_EXPIRES_IN` | `7d` | Access token lifetime |
| `REFRESH_TOKEN_EXPIRES_IN` | `30d` | Refresh token lifetime |
| `CORS_ORIGINS` | any origin | Comma-separated list of web app addresses allowed to call the API |
| `TRUST_PROXY` | | Set to `1` behind a hosting proxy such as Render |
| `LOGIN_RATE_LIMIT_PER_IP` | `30` | Login attempts per device every 15 minutes |
| `LOGIN_RATE_LIMIT_PER_PHONE` | `10` | Login attempts per phone number every 15 minutes |
| `REGISTER_RATE_LIMIT_PER_IP` | `10` | Sign-ups per device every hour |
| `DEMO_MODE` | `false` | Local only: lets requests without a token act as the demo trader |
| `AUTO_SEED` | `true` | Load the demo shop into an empty database on first start |
| `ML_SERVICE_URL` | | Address of the ML service. Leave empty to use only the built-in parser |
| `ML_API_KEY` | | Key sent to the ML service as `X-API-Key` |
| `ML_TIMEOUT_MS` | `15000` | How long to wait for the ML service |
| `ML_COOLDOWN_MS` | `60000` | After the ML service fails, how long to use the built-in parser before trying again |
| `ML_CONFIDENCE_THRESHOLD` | `0.6` | Below this, the app asks the trader to check carefully or repeat |
| `INTERNAL_SERVICE_API_KEY` | | Lets the ML service read the report endpoints |
| `CLOUDINARY_URL` | | Private storage for voice notes and receipt photos. Required in production |
| `MEDIA_RETENTION_DAYS` | `90` | Uploaded files are deleted after this many days (`0` keeps them) |
| `ALERT_SCHEDULER_ENABLED` | `true` | Run the hourly alert check |
| `ALERT_SCAN_INTERVAL_MINUTES` | `60` | How often alerts are checked |
| `ALERT_EXPENSE_RISE_PERCENT` | `25` | Weekly expense increase that triggers an alert |

Instead of `CLOUDINARY_URL` you can set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and
`CLOUDINARY_API_SECRET`.

## Project layout

The code is organised by feature. Each folder in `modules/` holds the routes, controller,
business logic and database models for one area.

```text
server.js          starts the server: database, demo data, alert scheduler
app.js             Express setup, health check, API docs, error handling
routes.js          mounts every module under /api
config/            database connection and CORS settings
common/            shared middleware (errors, validation, rate limits, uploads) and helpers
modules/
  auth/            sign up, login, tokens, business profile
  products/        product catalogue
  inventory/       stock levels and stock movements
  sales/           sales, including credit sales
  purchases/       stock bought from suppliers
  expenses/        business expenses
  debts/           customers, debts, repayments and reminders
  dashboard/       dashboard totals
  reports/         profit and loss, cash flow, best sellers, sales rate
  alerts/          alerts, insights and the hourly scheduler
  ai/              voice, receipt and text input, the confirm and edit flow, and the ML service client
seed/              demo shop data
docs/              OpenAPI spec (swagger.json)
tests/             automated tests
```

Files follow the pattern `<feature><Type>.js`, for example `saleController.js` or `stockService.js`.

## API overview

All endpoints are under `/api` and need an `Authorization: Bearer <token>` header, except
register, login and refresh. Full details, request bodies and error codes are in the Swagger docs.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `GET /auth/me`, `PUT /auth/language` |
| Dashboard | `GET /dashboard?timeRange=today\|7d\|30d\|90d` |
| Products | `GET`, `POST /products`, `GET`, `PUT`, `DELETE /products/:id` |
| Stock | `GET /stock`, `GET`, `POST /stock/movements` |
| Sales, purchases, expenses | `GET`, `POST /sales`, `/purchases`, `/expenses` |
| Debts | `GET /debts`, `POST /debts/payments`, `GET /debts/reminders/:debtId`, `GET`, `POST /debts/customers` |
| Reports | `GET /reports/profit-loss`, `/reports/cash-flow`, `/reports/top-products`, `/reports/sales-rate`, `/reports/daily-sales` |
| Alerts | `GET /alerts`, `PATCH /alerts/:id/read`, `POST /alerts/generate` |
| AI input | `POST /ai/text`, `/ai/voice`, `/ai/receipt` |
| Confirm, edit, cancel | `GET`, `PATCH /ai/actions/:id`, `POST /ai/actions/:id/confirm`, `POST /ai/actions/:id/reject` |
| Ask My Business | `POST /ai/ask` |

Errors come back as `{ "success": false, "code": "...", "message": "..." }`, so the app can react to
the `code`.

### How an AI action works

1. The app sends text, a voice note or a receipt photo to `/api/ai/text`, `/api/ai/voice` or
   `/api/ai/receipt`.
2. The backend returns a proposed action, for example:

   ```json
   {
     "id": "651a9f123bc4567890abcdef",
     "intent": "add_inventory",
     "language": "en",
     "transcript": "I bought 50 bags of rice for 4 million naira",
     "entities": { "product": "Mama Gold Rice 50kg", "quantity": 50, "unit": "bag", "totalAmount": 4000000, "unitCost": 80000 },
     "confidence": 0.96,
     "lowConfidence": false,
     "confirmationMessage": "Add 50 bags of Mama Gold Rice 50kg at ₦80,000 each?",
     "status": "proposed"
   }
   ```

3. The app shows the confirmation message with Confirm, Edit and Cancel buttons.
   Edit sends `PATCH /api/ai/actions/:id` with the corrected fields, Confirm sends
   `POST /api/ai/actions/:id/confirm`, and Cancel sends `POST /api/ai/actions/:id/reject`.

Only Confirm writes to stock, sales, expenses or debts. Pressing Confirm twice saves once.

### Sessions

Login and registration return a short-lived access token and a refresh token. Call
`POST /api/auth/refresh` to get a new pair, and always keep the newest refresh token, because an old
one stops working once it has been used. `POST /api/auth/logout` ends the current session and
`POST /api/auth/logout-all` ends every session for that user.

### Uploads

Voice notes and receipt photos must be under 10 MB. Images can be JPEG, PNG or WebP; audio can be
M4A, AAC, MP3, WAV, OGG or WebM. Files are stored privately (Cloudinary in production, the local
`uploads/` folder during development) and can only be fetched by the business that uploaded them,
through `GET /api/ai/actions/:id/media`. They are deleted after `MEDIA_RETENTION_DAYS`, while the
record of the action is kept.

## Working with the ML service

The ML engineer's service provides speech recognition, message understanding, receipt reading,
answers to questions and business insights. Set `ML_SERVICE_URL` (and `ML_API_KEY` if the
service needs one) to connect it. Until then, leave `ML_SERVICE_URL` empty and the backend uses
its built-in parser.

The `engine` field in AI responses shows who answered: `ml` for the ML service, `local` for the
built-in parser.

For the frontend, `npm run mock:api` serves example responses from the Swagger spec on port 4010,
so screens can be built before the backend is deployed.

## Tests

```bash
npm test
```

This runs every test suite, including the full demo script. The tests always use their own temporary
in-memory database, so they never touch the database in your `.env`.

## Deployment

Before deploying:

1. In MongoDB Atlas, under Network Access, allow connections from your host (for a demo, "Allow
   access from anywhere" with a strong database password).
2. On the host, set `NODE_ENV=production`, `MONGODB_URI`, `JWT_SECRET`, `CORS_ORIGINS`, `TRUST_PROXY=1`
   and the Cloudinary credentials. Without
   Cloudinary, voice and receipt uploads are refused in production.
3. After deploying, open `/health` and check that it shows `"databaseType": "mongodb"`.
