# BookOn – Complete Codebase Explanation

This document describes the **BookOn** project structure, architecture, and the purpose of major files and folders. BookOn is a **white-label booking platform** for schools and clubs: parents book activities for children, providers manage venues/activities/registers, and the platform handles payments (Stripe), notifications, and reporting.

---

## 1. Project Overview

| Aspect | Details |
|--------|---------|
| **Purpose** | White-label booking for schools/clubs: venues, activities, bookings, payments, registers, communications |
| **Stack** | React 18 + TypeScript (frontend), Node.js + Express + TypeScript (API), PostgreSQL (Prisma + optional Knex), Redis, Stripe |
| **Deployment** | Vercel (frontend + API), Neon/Supabase for PostgreSQL |
| **Monorepo** | Root `package.json` uses workspaces: `frontend`, `api`. A separate `backend/` folder exists with an extended server (see below). |

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React)                          │
│  Vite, Tailwind, React Router, TanStack Query, Auth + Cart ctx   │
└───────────────────────────────┬───────────────────────────────────┘
                                │ HTTPS /api/v1/*
┌───────────────────────────────▼───────────────────────────────────┐
│                    API LAYER (Express)                              │
│  api/src/index.ts  OR  backend/src/index.ts (see Deployment)       │
│  Routes → Middleware (auth, errors) → Services → Prisma/Knex     │
└───────────────────────────────┬───────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────┐
│  PostgreSQL (Prisma ORM, schema in api/prisma/schema.prisma)       │
│  Redis (sessions, token blacklist, rate limiting)                 │
└───────────────────────────────────────────────────────────────────┘
```

- **Frontend** talks to the API at `VITE_API_URL` (e.g. `https://bookon-api.vercel.app/api/v1`).
- **API** is either:
  - **`api/`** – workspace package, entry `api/src/index.ts`, deployable as its own Vercel project (`api/vercel.json`).
  - **`backend/`** – fuller server used by root `vercel.json` (builds `backend/src/index.ts`); adds business dashboard, bank feed, more routes and services.
- **Database**: Prisma is the main ORM; `api/prisma/schema.prisma` defines all models. Knex is still present in `api` for migrations/seeds in some paths.

---

## 3. Root Directory

| File / Folder | Purpose |
|---------------|--------|
| **`package.json`** | Workspace root: `workspaces: ["frontend", "api"]`. Scripts run `dev:backend` from `api`, `dev:frontend` from `frontend`. |
| **`vercel.json`** | Root Vercel config: builds and serves **`backend/src/index.ts`**; routes `/api/(.*)` to it. So the “main” production API is the backend server. |
| **`.env.example`** | Template for `DATABASE_URL`, `DATABASE_DIRECT_URL`, `JWT_*`, Stripe, Supabase, SendGrid, `VITE_API_URL`, etc. |
| **`docker-compose.yml`** | Local dev stack (e.g. Postgres, Redis). |
| **`PLAN.md`** | Product/architecture plan: phases, schema ideas, tech stack. |
| **`README.md`** | Setup, env vars, quick start, deployment, testing. |
| **`.github/workflows/ci.yml`** | CI: lint/typecheck (backend + frontend), backend tests (Postgres + Redis), frontend tests, build both, security (npm audit, Snyk), deploy staging/production. Uses **backend** and **frontend** (not `api`). |
| **`docs/`** | API docs, widget integration, phase completion notes. |
| **`scripts/`** | e.g. `init-db.sql` for DB init. |
| **`supabase_*.sql`** | Supabase migration scripts. |
| **`*_SUMMARY.md` / `*_FIX*.md`** | Implementation and fix notes (e.g. API fixes, booking flow, dashboard, registers). |

---

## 4. API Package (`api/`)

This is the Express API used as a workspace app and can be deployed standalone.

### 4.1 Entry and config

| File | Purpose |
|------|--------|
| **`api/src/index.ts`** | Main entry: loads env, creates Express app and HTTP server, applies security (Helmet, CORS, rate limit, slow-down), body parsing, compression, morgan logging. Mounts all `/api/v1/*` routes, health/debug/test endpoints, then `notFound` and `errorHandler`. Starts DB connection, WebSocket service, cron service, scheduler; listens on `PORT`. |
| **`api/vercel.json`** | Vercel config for **api** as a separate project: build `src/index.ts`, route all requests to it. |
| **`api/package.json`** | Dependencies (express, prisma, stripe, jwt, redis, etc.) and scripts (dev, build, start, db migrate/seed). |
| **`api/prisma/schema.prisma`** | Single source of truth for PostgreSQL: generator + datasource (`DATABASE_URL` / `DATABASE_DIRECT_URL`), and all models (see Database section). |
| **`api/knexfile.js`** | Knex config for migrations/seeds if used (legacy or alternate path). |

### 4.2 Middleware (`api/src/middleware/`)

| File | Purpose |
|------|--------|
| **`auth.ts`** | JWT auth: `authenticateToken` (Bearer token, Redis blacklist, optional refresh via `X-Refresh-Token`), `optionalAuth`, `requireRole` / `requireAdmin` / `requireStaff`, `requireEmailVerification`, `authRateLimit`, `validateSession`, `logout` (blacklist). Attaches `req.user` (id, email, role, isActive). |
| **`errorHandler.ts`** | Central error handler: `AppError` class, maps validation/JWT/DB/Stripe errors to status codes and JSON; `asyncHandler` wrapper; `notFound` for 404. |
| **`notFound.ts`** | 404 handler for unknown routes. |

### 4.3 Routes (`api/src/routes/`)

Routes are mounted under `/api/v1/<path>` in `index.ts`. Each file typically uses `authenticateToken` and/or `requireRole` and delegates business logic to services.

| File | Purpose |
|------|--------|
| **`auth.ts`** | Login, register, refresh, logout. |
| **`users.ts`** | User CRUD and profile. |
| **`notifications.ts`** | List/read/update notifications. |
| **`children.ts`** | Parent’s children CRUD. |
| **`dashboard.ts`** | Dashboard stats and recent activity. |
| **`activities.ts`** | Activities list/create/update/delete, filters. |
| **`activity-types.ts`** | Activity type CRUD. |
| **`venues.ts`** | Venues CRUD. |
| **`bookings.ts`** | Bookings create/list/update, status, filters. |
| **`payments.ts`** | Payment intents, status, history. |
| **`admin.ts`** | Admin-only: stats, venues, activities, users, bookings, exports, system config, audit logs, bulk actions, email templates, broadcast, financial reports, payment settings. |
| **`widget.ts`** | Public/widget endpoints for embeddable booking. |
| **`widget-config.ts`** | Widget configuration CRUD. |
| **`registers.ts`** | Registers and register entries (attendance). |
| **`webhooks.ts`** | Incoming webhooks (e.g. Stripe), health. |
| **`setup.ts`** | Setup/onboarding. |
| **`tfc.ts`** | Tax-Free Childcare (TFC) flow. |
| **`admin-tfc.ts`** | Admin TFC management. |
| **`cancellations.ts`** | Cancellation requests and processing. |
| **`wallet.ts`** | Parent wallet/credits. |
| **`provider-settings.ts`** | Provider (venue) settings (TFC, refund policy, etc.). |
| **`audit.ts`** | Audit log read API. |
| **`edge-cases.ts`** | Edge-case handling endpoints. |
| **`data-retention.ts`** | Data retention policies. |
| **`dashboard-snapshot.ts`** | Dashboard snapshot/cache. |
| **`upcoming-activities.ts`** | Upcoming activities. |
| **`finance-summary.ts`** | Finance summary. |
| **`templates.ts`** | Email/template management. |
| **`courses.ts`** | Courses (from templates). |
| **`business-accounts.ts`** | Stripe Connect business accounts. |
| **`finance-reporting.ts`** | Finance reports. |
| **`communications.ts`** | Communications/broadcasts. |
| **`finance.ts`** | Finance endpoints. |
| **`health.ts`** | Health check for API/dependencies. |

### 4.4 Services (`api/src/services/`)

Business logic used by routes; use Prisma (and sometimes Stripe/Redis).

| File | Purpose |
|------|--------|
| **`stripe.ts`** | Stripe SDK usage, payment intents, Connect. |
| **`stripeConnectService.ts`** | Stripe Connect onboarding and account handling. |
| **`activityService.ts`** | Activity creation, updates, capacity. |
| **`auditService.ts`** | Write audit log entries. |
| **`automatedEmailService.ts`** | Triggered emails (booking, reminders, etc.). |
| **`cancellationService.ts`** | Cancel bookings, refund/credit logic. |
| **`cronService.ts`** | Scheduled jobs (notifications, reminders). |
| **`dataRetentionService.ts`** | Apply retention policies. |
| **`edgeCaseService.ts`** | Edge-case handling. |
| **`emailService.ts`** | Send emails (e.g. SendGrid). |
| **`franchiseFeeService.ts`** | Platform/franchise fee calculation. |
| **`notificationAutomationService.ts`** | Automated notification rules. |
| **`notificationService.ts`** | Create/send in-app (and other) notifications. |
| **`paymentRoutingService.ts`** | Route payments to Connect accounts. |
| **`registerService.ts`** | Create/update registers and entries. |
| **`schedulerService.ts`** | Scheduled tasks (TFC deadlines, wallet). |
| **`tfcService.ts`** | TFC booking and payment flow. |
| **`walletService.ts`** | Wallet credits and usage. |
| **`websocketService.ts`** | Real-time updates over WebSocket. |

### 4.5 Models (`api/src/models/`)

TypeScript models (e.g. `User`, `Venue`, `Activity`, `Booking`, `Child`) used for typing; actual schema is in **Prisma**. These may mirror Prisma or be used in Knex-based code paths.

### 4.6 Utils (`api/src/utils/`)

| File | Purpose |
|------|--------|
| **`prisma.ts`** | Prisma client singleton, `safePrismaQuery` wrapper, `checkDatabaseConnection`. |
| **`prismaDirect.ts`** | Direct Prisma usage helpers if needed. |
| **`database.ts`** | Knex connection (e.g. for migrations/seeds) with Supabase-friendly config. |
| **`logger.ts`** | Winston logger and security logging. |
| **`redis.ts`** | Redis client for cache, sessions, token blacklist. |
| **`validation.ts`** | Request validation helpers. |
| **`email.ts`** | Email-related helpers. |

### 4.7 Types, migrations, seeds, tests

- **`api/src/types/index.ts`** – Shared TS types.
- **`api/src/migrations/`** – Knex migrations (e.g. registers, widget, analytics). Prisma migrations live in **`api/prisma/`** (e.g. `migrations/` if used).
- **`api/src/seeds/`** – Sample data seeds.
- **`api/src/scripts/seed.ts`** – Seed runner.
- **`api/__tests__/`** and **`api/src/__tests__/`** – Auth and basic API tests, Stripe tests, setup.

---

## 5. Backend Package (`backend/`)

The **backend** folder is a second, larger Node server. Root **`vercel.json`** points here for production, and **CI uses backend + frontend**.

### 5.1 Relation to `api/`

- **Same stack**: Express, TypeScript, Prisma, same schema concept (backend has its own **`backend/prisma/schema.prisma`** and migrations).
- **Backend adds**:
  - More routes: business dashboard, business activities/finance/templates/venues/communications/registers/widgets/users/settings/notifications/bookings, bank feed, master reports, calendar, upload, session blocks, session templates, child permissions, user credits, discounts, checkout, debug.
  - More services: e.g. `bankFeedService`, `capacityService`, `creditService`, `paymentService`, `providerNotificationService`, `realTimeRegisterService`, `refundNotificationService`, `refundPolicyService`, `refundService`, `eventService`, `gdprComplianceService`, `tfcDeadlineService`, etc.
- **Entry**: **`backend/src/index.ts`** – same structure as api (middleware, routes, WebSocket, cron, scheduler), but with the extended route and service set.

### 5.2 Backend layout (summary)

| Area | Purpose |
|------|--------|
| **`backend/src/index.ts`** | Main server entry. |
| **`backend/src/routes/`** | All api routes plus business*, bankFeed, checkout, discounts, userCredits, upload, calendar, sessionBlocks, sessionTemplates, childPermissions, businessDashboard, masterReports, debug, etc. |
| **`backend/src/services/`** | All api services plus bank feed, capacity, credit, payment, provider notification, refund, real-time register, GDPR, TFC deadline, etc. |
| **`backend/src/middleware/`** | Same idea as api (auth, errorHandler, notFound). |
| **`backend/src/utils/`** | Same as api plus e.g. supabase, calendarService, holidayService. |
| **`backend/prisma/`** | Schema and migrations. |
| **`backend/sql/`** | Raw SQL (e.g. phase 5 tables). |
| **`backend/src/__tests__/`** | Broader tests (registers, payments, refunds, provider notifications, etc.). |

Many one-off scripts in **`backend/`** root (e.g. `check-*.js`, `fix-*.js`, `test-*.js`) are for debugging and one-time fixes.

---

## 6. Frontend (`frontend/`)

React SPA: Vite, TypeScript, Tailwind, React Router, TanStack Query.

### 6.1 Entry and config

| File | Purpose |
|------|--------|
| **`frontend/src/main.tsx`** | Renders `<App />` in `#root` with `React.StrictMode`. |
| **`frontend/src/App.tsx`** | Wraps app in `QueryClientProvider`, `AuthProvider`, `NotificationProvider`, `BasketProvider`, `AuthErrorBoundary`, `Router`; defines all `<Route>`s inside `<Layout>`; global Toaster. Route list: public (home, login, register, widget), dashboard (role-based), business/*, parent/*, activities, basket, checkout, bookings, children, venues, admin/*, notifications, profile, wallet, etc. |
| **`frontend/index.html`** | HTML shell with `#root`. |
| **`frontend/vite.config.ts`** | Vite config (build, dev server, aliases). |
| **`frontend/tailwind.config.js`** | Tailwind theme and content paths. |
| **`frontend/package.json`** | React, React Router, TanStack Query, Axios, Tailwind, etc. |
| **`frontend/src/index.css`** | Global and Tailwind imports. |

### 6.2 Config and API client

| File | Purpose |
|------|--------|
| **`frontend/src/config/api.ts`** | **Primary API config**: `API_CONFIG.BASE_URL` (e.g. `VITE_API_URL` or `https://bookon-api.vercel.app/api/v1`), endpoint constants, **Axios** instance with request interceptor (Bearer + refresh token) and response interceptor (401 → refresh or redirect to login). |
| **`frontend/src/services/api.ts`** | Alternative helper: `api.url()`, `api.request()`, `api.get/post/put/patch/delete` using `fetch` and `VITE_API_BASE_URL`. |

Pages may use either the Axios client from `config/api.ts` or the fetch-based `services/api.ts`.

### 6.3 Contexts and auth

| File | Purpose |
|------|--------|
| **`contexts/AuthContext.tsx`** | Auth state (user, login, logout, register), token storage, persistence. |
| **`contexts/CartContext.tsx`** | Basket/cart state (e.g. for booking flow). |
| **`contexts/NotificationContext.tsx`** | In-app notifications. |
| **`hooks/useAuth.ts`** | Hook to access auth context. |
| **`hooks/useNotifications.ts`** | Hook for notifications. |
| **`components/Auth/ProtectedRoute.tsx`** | Wraps routes that require login. |
| **`components/Auth/RoleBasedProtectedRoute.tsx`** | Restricts by role (e.g. admin, business, parent). |
| **`components/AuthErrorBoundary.tsx`** | Catches auth-related errors and can redirect. |
| **`utils/authUtils.ts`** | e.g. `clearAllAuthData()`. |

### 6.4 Layout and routing

| File | Purpose |
|------|--------|
| **`components/layout/Layout.tsx`** | Main layout (header, sidebar, outlet for children). |
| **`components/layout/Header.tsx`** | Top bar, nav, user menu. |
| **`components/layout/Footer.tsx`** | Footer. |
| **`components/layout/AdminLayout.tsx`** | Admin area layout. |
| **`components/layout/BusinessLayout.tsx`** | Business provider layout. |
| **`components/DashboardRouter.tsx`** | Routes user to correct dashboard by role (parent, business, admin). |

### 6.5 Pages (by area)

- **Public**: `HomePage`, `Auth/LoginPage`, `Auth/RegisterPage`, `WidgetPage`, `NotFoundPage`.
- **Dashboard**: `Dashboard/DashboardPage` (parent), `Business/BusinessDashboard`, onboarding, profile, bookings, activities, create/edit activity, registers, finance, communications, templates, venues, widget, notifications, users, settings, sessions.
- **Admin**: `Admin/AdminDashboard`, venues, activities, activity types, bookings, users, financial, email templates, broadcast, notification center, registers, TFC queue, payment settings, export, provider settings, webhooks, bank feed, advanced tools, etc.
- **Parent**: `Parent/ChildrenPage`, `MyBookingsPage`, `WalletPage`; `Children/AddChildPage`, permissions; `Bookings/BookingsPage`, `BookingDetailPage`, `BookingEditPage`, `ParentBookingFlow`; wraparound and holiday club booking/checkout.
- **Activities**: `Activities/ActivitiesPage`, `ActivityBookingPage`, `ActivityConfirmationPage`, `CourseBookingPage`, `WaitingListPage`; checkout pages (activity, course, holiday club, cart).
- **Venues**: `Venues/VenuesPage`, `VenueDetailPage`.
- **Cart/Checkout**: `Cart/CartPage`, `Checkout/CheckoutPage`, `CartPaymentPage`, `CartCheckoutSuccessPage`, `ActivityCheckoutPage`, `CourseCheckoutPage`, etc.
- **Payment**: `Payment/PaymentPage`, `PaymentSuccessPage`; `PendingPaymentPage`.
- **Other**: `Profile/ProfilePage`, `Notifications/NotificationsPage`, `Reports/ReportsPage`, `Permissions/PermissionsPage`, `ActivityLogPage`.

### 6.6 Components (selected)

- **Auth**: `ProtectedRoute`, `RoleBasedProtectedRoute`, `AuthErrorBoundary`.
- **Booking**: `BookingWidget`, `BookingActions`, `CalendarView`, `CancellationModal`, `EmbeddableWidget`, `MobileBookingFlow`.
- **Business**: `BusinessCalendarView`, `HolidayExclusion`.
- **Charts**: `FinanceChart`, `RevenueChart`.
- **Children**: `ChildForm`.
- **Communications**: `BroadcastModal`, `TemplateModal`.
- **Finance**: `CreditModal`, `DiscountModal`, `RefundModal`.
- **Payment**: `PaymentForm`, `StripePayment`, `TFCInstructionPanel`, `TFCPaymentOption`, `PaymentSuccess`.
- **Registers**: `CreateRegisterModal`, `GeneralCreateRegisterModal`.
- **Templates**: `CreateCourseModal`, `CreateTemplateModal`, `EditTemplateModal`.
- **UI**: `Button`, `Card`, `Input`, `Modal`, `Table`, `Select`, `Badge`, `Pagination`, `Stepper`, etc. in `components/ui/`.
- **Other**: `CalendarIntegration`, `CalendarWidget`, `RichTextEditor/RichTextEditor`, `CancellationPreviewModal`.

### 6.7 Services and types

- **`services/api.ts`** – Fetch-based API helper.
- **`services/authService.ts`** – Login, register, refresh.
- **`services/bookingService.ts`** – Booking API calls.
- **`services/calendarService.ts`** – Calendar/availability.
- **`services/childrenService.ts`** – Children API.
- **`services/googleCalendarService.ts`** – Google Calendar.
- **`services/notificationService.ts`** – Notifications API.
- **`services/widgetService.ts`** – Widget config.
- **`types/booking.ts`** – Booking-related types.
- **`utils/cn.ts`****, **`formatting.ts`** – Class names and formatters.

---

## 7. Database (Prisma schema summary)

**`api/prisma/schema.prisma`** (and backend’s equivalent) defines PostgreSQL models. Main groups:

- **Identity**: `User` (roles, stripe customer, venue link), `Child` (parent, DOB, year group, allergies).
- **Venues & activities**: `Venue` (owner, business account, Stripe Connect, franchise fee), `ActivityType`, `Activity` (venue, owner, type, capacity, price, status).
- **Bookings & payments**: `Booking` (activity, child, parent, status, payment status, TFC fields, amounts), `Payment`, `RefundTransaction`, `WalletCredit`, `Credit`, `Refund`, `Transaction`.
- **Provider/finance**: `BusinessAccount`, `ProviderSettings`, `Payout`, `Chargeback`, `Discount`.
- **Registers**: `Register` (venue, activity, date), register entries (handled in services).
- **Communications**: `EmailTemplate`, `Broadcast`, `Email`, `EmailEvent`.
- **Courses**: `Template`, `Course`, `Session`.
- **System**: `Notification`, `WebhookEvent`, `WebhookConfig`, `WidgetConfig`, `WidgetAnalytics`, `AuditLog`, `DataRetention` (if present).

Relations and indexes are defined in the schema; Prisma Client is generated from it and used in **api** and **backend**.

---

## 8. Key Flows (short)

- **Login**: Frontend → `POST /api/v1/auth/login` → auth route → JWT + refresh token → stored in localStorage; Axios interceptor adds Bearer and handles 401 refresh.
- **Booking**: Parent selects activity/child → cart/checkout → create booking → payment (Stripe or TFC) → webhook updates payment/booking status; register can be created/updated by backend logic.
- **Provider**: Business user manages venues, activities, registers, finance, communications, widget via business routes and pages; admin has separate routes and dashboard.
- **Deployment**: Root Vercel project builds **backend** and serves it under `/api`; frontend is typically a separate Vercel app or static deploy pointing to that API URL.

---

## 9. Quick reference: where to look

| Need to… | Look in |
|----------|--------|
| Change API routes or add endpoint | `api/src/routes/` or `backend/src/routes/` |
| Change auth or RBAC | `api/src/middleware/auth.ts` (and backend copy) |
| Change DB schema | `api/prisma/schema.prisma`, then migrate |
| Change business logic for bookings/payments/registers | `api/src/services/` or `backend/src/services/` |
| Change frontend routes or role redirect | `frontend/src/App.tsx`, `DashboardRouter.tsx` |
| Change API base URL or auth handling in UI | `frontend/src/config/api.ts`, `contexts/AuthContext.tsx` |
| Add a new page | `frontend/src/pages/`, then add route in `App.tsx` |
| Change CI (lint, test, build) | `.github/workflows/ci.yml` |
| Change deployment target | Root `vercel.json` (backend) or `api/vercel.json` (api only) |

---

This file gives a single place to understand the BookOn codebase and find the right files for changes. For API contract details, see **`docs/API_DOCUMENTATION.md`** and **`docs/widget-integration.md`**.
