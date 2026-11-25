// Runs this service alone on your PC: npm run dev  ->  http://localhost:3003
// To run ALL services behind one URL (like API Gateway), use: node infra/local-gateway.js
const app = require('./app');

const PORT = Number(process.env.PORT) || 3003;
app.listen(PORT, () => {
  console.log(`pb-transactions-service listening on http://localhost:${PORT}`);
});
