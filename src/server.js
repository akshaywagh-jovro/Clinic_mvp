import 'dotenv/config';
import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import routes from './routes.js';

// strict: false lets our route schemas use the OpenAPI-only "example" keyword,
// which plain JSON Schema's AJV validator would otherwise reject.
const app = Fastify({ logger: true, ajv: { customOptions: { strict: false } } });

// Generates the OpenAPI spec from each route's `schema` block.
app.register(fastifySwagger, {
  openapi: {
    info: {
      title: 'Clinic Receptionist API',
      description: 'Endpoints Retell calls mid-conversation to look up patients and manage appointments.',
      version: '1.0.0',
    },
    tags: [
      { name: 'Patients', description: 'Patient identity lookup' },
      { name: 'Appointments', description: 'Availability, booking, reschedule, cancel' },
    ],
  },
});

// Interactive "Try it out" UI, served at /docs.
app.register(fastifySwaggerUi, { routePrefix: '/docs' });

// Retell nests custom-function arguments under `args`. Flatten them so handlers
// can read fields off request.body directly whether Retell sends them nested or flat.
app.addHook('preHandler', async (request) => {
  const b = request.body;
  if (b && typeof b === 'object' && b.args && typeof b.args === 'object') {
    request.body = { ...b, ...b.args };
  }
});

app.get('/health', async () => ({ status: 'ok' }));
app.register(routes);

// Anything a handler throws lands here.
app.setErrorHandler((err, request, reply) => {
  request.log.error(err);
  reply.code(500).send({ error: 'internal_error' });
});

const port = Number(process.env.PORT) || 3000;
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`API docs: http://localhost:${port}/docs`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
