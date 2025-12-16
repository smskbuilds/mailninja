# MailNinja Setup Guide

## Prerequisites
- Node.js 18+ installed
- A Google Cloud account

## Step 1: Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (ID: `project-aa2e1fee-1855-4d56-98e`)

### Enable Gmail API

1. Go to **APIs & Services** → **Library**
2. Search for "Gmail API"
3. Click on it and press **Enable**

### Create OAuth Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
3. If prompted, configure the OAuth consent screen first:
   - User type: **External** (or Internal if using Workspace)
   - App name: `MailNinja`
   - User support email: your email
   - Developer contact: your email
   - Click **Save and Continue** through the remaining steps
4. Back on Credentials, create OAuth client ID:
   - Application type: **Web application**
   - Name: `MailNinja Web Client`
   - Authorized JavaScript origins: `http://localhost:3000`
   - Authorized redirect URIs: `http://localhost:3000/api/auth/callback/google`
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**

## Step 2: Configure Environment

1. Copy the example env file:
   ```bash
   cp env.example .env.local
   ```

2. Edit `.env.local` with your credentials:
   ```
   GOOGLE_CLIENT_ID=your_client_id_here
   GOOGLE_CLIENT_SECRET=your_client_secret_here
   NEXTAUTH_URL=http://localhost:3000
   NEXTAUTH_SECRET=generate_a_random_32_char_string
   ```

3. Generate a NextAuth secret (run in terminal):
   ```bash
   openssl rand -base64 32
   ```

## Step 3: Add Test Users (Required for External OAuth)

Since the app is in development, you need to add yourself as a test user:

1. Go to **APIs & Services** → **OAuth consent screen**
2. Scroll down to **Test users**
3. Click **+ ADD USERS**
4. Add your Gmail address
5. Click **Save**

## Step 4: Run the App

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000)

## Troubleshooting

### "Access Denied" or "App not verified"
- Make sure you added your email as a test user in the OAuth consent screen
- If using @gmail.com, the consent screen will show a warning - click "Advanced" → "Go to MailNinja (unsafe)" to proceed

### "Invalid redirect URI"
- Verify the redirect URI in Google Cloud matches exactly: `http://localhost:3000/api/auth/callback/google`

### Token refresh issues
- The OAuth prompt is set to "consent" to always get a refresh token
- If tokens expire, sign out and sign back in
