# Botub AI - Standalone Deployment Guide

This application is ready to be deployed on **Vercel** or any Node.js environment.

## Deployment to Vercel

1. **Connect your GitHub Repository** to Vercel.
2. **Environment Variables**: Add all variables from `.env.example` to your Vercel project settings.
   - For `FIREBASE_SERVICE_ACCOUNT`, you can download the JSON key from your Firebase Console (Project Settings > Service Accounts) and paste the ENTIRE JSON string as the value.
3. **Build Command**: `npm run build`
4. **Install Command**: `npm install`
5. **Output Directory**: `dist`

## Features
- **Standalone Backend**: The `api/` directory contains serverless functions for Vercel.
- **SPA Routing**: `vercel.json` handles all client-side routes, preventing 404 on refresh.
- **Security**: Backend routes are protected by Firebase Admin authentication.

## Local Development
1. `npm install`
2. Create a `.env` file based on `.env.example`.
3. `npm run dev`


<p align="center"><a href="https://dashboard.heroku.com/new?template=https://github.com/pagal4206/botub.ai"> <img src="https://img.shields.io/badge/Deploy%20On%20Heroku-bringle?style=for-the-badge&logo=heroku" width="220" height="38.45"/></a></p>
