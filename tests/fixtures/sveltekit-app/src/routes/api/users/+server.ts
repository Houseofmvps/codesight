export async function GET() {
  return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
}
export async function POST({ request }) {
  return new Response(JSON.stringify({}));
}