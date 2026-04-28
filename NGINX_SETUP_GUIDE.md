# Nginx Reverse Proxy Setup Guide - Port 8080

## Overview
This guide documents the Nginx reverse proxy configuration that routes traffic to backend services on port 8080.

## Quick Start

### 1. Configuration File
The main Nginx configuration is located at:
- `/Users/mainingze/financial expert/financial-expert-new/deploy/nginx.conf`

Key settings:
- **Listen Ports**: 80, 8080
- **API Proxy**: `http://api:8000`
- **Frontend Proxy**: `http://frontend:3000`

### 2. Deploy Services
```bash
cd /Users/mainingze/financial\ expert/financial-expert-new
docker compose up -d
```

### 3. Verify Deployment
```bash
# Test API health
curl http://localhost:8080/api/health

# Check version
curl http://localhost:8080/api/version
```

## Nginx Configuration Details

### Port Configuration
- **Port 80**: Standard HTTP (production)
- **Port 8080**: Reverse proxy for development/testing

### Routing Rules
| Path Pattern | Backend Service | Port |
|--------------|----------------|------|
| `/api/*` | API Service | 8000 |
| `/*` | Frontend Service | 3000 |

### Proxy Headers
```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

## Health Monitoring

### API Health Check
The deployment includes automated health monitoring:
- **Timeout**: 30 seconds
- **Endpoints**: `/api/version`, `/api/health`
- **Retry Logic**: Up to 30 attempts with 1-second intervals

### Manual Health Check
```bash
# Check API is responding
curl -s http://localhost:8080/api/version

# Check API health status
curl -s http://localhost:8080/api/health
```

## Troubleshooting

### Common Issues

1. **API Not Responding**
   ```bash
   docker compose logs api
   docker compose ps
   ```

2. **Nginx Configuration Errors**
   ```bash
   docker exec -it <nginx-container> nginx -t
   ```

3. **WebSocket Connection Issues**
   - Ensure `Upgrade` and `Connection` headers are properly forwarded
   - Check Nginx configuration includes WebSocket support

## Security Considerations

- **Environment Variables**: Store API keys in `.env` file
- **Network Isolation**: Services communicate via Docker internal network
- **Rate Limiting**: Consider adding rate limiting for production
- **SSL/TLS**: Add HTTPS configuration for production use

## Performance Optimization

- **Client Max Body Size**: 350MB
- **Proxy Timeouts**: 86400 seconds (24 hours)
- **Connection Keep-Alive**: Enabled via HTTP/1.1

## Additional Resources

- [Nginx Documentation](https://nginx.org/en/docs/)
- [Docker Compose](https://docs.docker.com/compose/)
- [FastAPI](https://fastapi.tiangolo.com/)
- [Next.js](https://nextjs.org/)