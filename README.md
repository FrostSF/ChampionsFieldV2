# Champions Field 🏆

Juego multijugador online top-down estilo HaxBall con mecánicas de Rocket League.

## Stack
- **Backend**: Node.js + Express + Socket.io (autoritative server, 60 TPS)
- **Frontend**: HTML5 Canvas puro (sin frameworks)
- **Hosting**: Fly.io (región Miami = ~70ms desde Colombia)
- **Anti-lag**: Client-Side Prediction + Server Reconciliation

## Controles
| Tecla | Acción |
|-------|--------|
| WASD / Flechas | Mover |
| Shift | Boost |
| Espacio / X | Dodge (con partículas moradas) |
| C | Cambiar cámara (Yo / Balón) |

## Mecánicas
- **Boost**: Se recarga automáticamente, o recógelo en los pads del mapa
- **Dodge**: Dash rápido en la dirección que te mueves, partículas moradas
- **Cámara**: Sigue a tu jugador o al balón, con scroll suave
- **Equipos**: Rojo vs Azul, hasta 4v4 (8 jugadores max)
- **Goles**: Primero en llegar a 5 gana

## Deploy en Fly.io (GRATIS)

### Prerequisitos
```bash
# Instalar flyctl
curl -L https://fly.io/install.sh | sh

# Login
flyctl auth login
```

### Primera vez
```bash
# En la carpeta del proyecto
cd champions-field

# Crear la app (usa fly.toml ya configurado)
flyctl launch --no-deploy

# Deploy
flyctl deploy
```

### Actualizaciones
```bash
flyctl deploy
```

### Ver logs
```bash
flyctl logs
```

## Configuración Fly.io
El `fly.toml` ya está configurado con:
- **Región**: `mia` (Miami) — ~70ms desde Colombia vs ~200ms en us-west
- **Machine**: shared-cpu-1x con 256MB RAM (tier GRATIS)
- **Auto-stop**: La máquina se apaga cuando no hay jugadores (ahorra créditos)
- **Puerto**: 3000 interno, HTTPS automático

## Estructura
```
champions-field/
├── server.js          # Servidor autoritative (física, salas, tick loop)
├── public/
│   └── index.html     # Cliente completo (juego + UI)
├── fly.toml           # Configuración Fly.io
├── Dockerfile
└── package.json
```

## Anti-lag implementado
1. **Client-Side Prediction**: Tu personaje se mueve inmediatamente sin esperar al servidor
2. **Server Reconciliation**: Si el servidor corrige tu posición, se aplica suavemente
3. **Interpolación**: Los otros jugadores y el balón se interpolan entre estados del servidor
4. **Input buffering**: Los inputs se encolan en el servidor para procesamiento ordenado
5. **WebSocket**: Conexión directa, sin HTTP overhead
