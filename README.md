

the projects structure is as follows:
# FitFlex Backend

This is the backend for the FitFlex project, built with **Node.js**, **Express**, and **PostgreSQL**.

---

## 📂 Folder Structure

fitflex-backend/
├── server.js # Main backend entry point
├── package.json # Node dependencies & scripts
├── .env # Environment variables (DATABASE_URL, PORT, etc.)
├── db/
│ ├── schema.sql # SQL commands to create tables
│ ├── seed.sql # Optional: Insert sample data
├── routes/ # API route files (optional, if separated)
└── README.md # This file

---

## 🛠 Setup

### Install dependencies
terminal cmd line:
bash: npm install

create env with the following variables:
PORT=3000
DATABASE_URL=postgresql://<username>:<password>@localhost:5432/fitflex

1. Start PostgreSQL
brew services start postgresql

2. Activate database
psql postgres
CREATE DATABASE fitflex;
\c fitflex
\i db/schema.sql

3. Start server
node server.js

Server will run on:
http://localhost:3000

Git Workflow
git add .
git commit -m "Describe your change"
git pull origin main   # Pull before pushing to avoid conflicts
git push origin main

✅ Checklist for Starting Work
1. Open Terminal in fitflex-backend

2. Start PostgreSQL:
brew services start postgresql

3. Start backend server:
node server.js

4. Check backend works:
curl http://localhost:3000/ping

🌐 Deployment
Backend is deployed on Render:
https://fitflex-backend-xxxx.onrender.com
To redeploy:

Push changes to main branch in GitHub — Render auto-redeploys.

Author:
Nadav Hardof
