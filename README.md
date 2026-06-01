# Botub AI - Deployment Guide

This application can run on **Heroku**, **Vercel**, or any Node.js host that supports a build step plus a long-running web process.

## Deployment to Heroku

1. Create a Heroku app and connect this repository, or deploy with the Heroku CLI.
2. Add all variables from `.env.example` to the Heroku app's Config Vars.
   - For `FIREBASE_SERVICE_ACCOUNT`, download the Firebase service account JSON, remove line breaks, and paste the full JSON as one string.
3. Heroku will install dependencies, run `npm run build`, and start the app with the included `Procfile`.
4. Make sure the app uses the default web process:
   - `web: npm start`
5. Open the app after deploy. The server now binds to Heroku's injected `PORT` automatically.

## Deployment to Vercel

1. Connect your GitHub repository to Vercel.
2. Add all variables from `.env.example` to the Vercel project settings.
   - For `FIREBASE_SERVICE_ACCOUNT`, download the Firebase service account JSON and paste the entire JSON string as the value.
3. Use `npm install` as the install command.
4. Use `npm run build` as the build command.
5. Use `dist` as the output directory.

## Features
- Express server for API routes and static SPA hosting in production.
- Vite middleware for local development.
- `vercel.json` support for Vercel rewrites.
- `Procfile` support for Heroku web dynos.

## Local Development
1. `npm install`
2. Create a `.env` file based on `.env.example`.
3. `npm run dev`


<p align="center"><a href="https://dashboard.heroku.com/new?template=https://github.com/pagal4206/botub.ai"> <img src="https://img.shields.io/badge/Deploy%20On%20Heroku-bringle?style=for-the-badge&logo=heroku" width="220" height="38.45"/></a></p>
