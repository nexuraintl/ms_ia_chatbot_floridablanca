# Guía de Arquitectura SaaS y Soluciones de Integración: Chatbot Multicliente

Este documento detalla las soluciones propuestas para convertir el chatbot de atención en un servicio **SaaS (Multi-tenant)** adaptable a múltiples clientes (alcaldías o empresas) sin necesidad de reescribir el código, así como las soluciones a los errores de inyección en servidores de desarrollo externos.

---

## 1. El Desafío Multicliente (Multi-tenant)
Cuando el chatbot corre como un microservicio en la nube (ej. **Google Cloud Run**), múltiples portales cliente lo consumirán incrustando la misma etiqueta de script. Para evitar tener la información y las respuestas automáticas acopladas a un solo municipio, el widget debe autoconfigurarse en tiempo de ejecución.

Proponemos tres enfoques de integración:

### Enfoque A: Configuración por Atributos de Datos (data-attributes)
El cliente pasa las variables básicas (título, mensajes iniciales, color del tema y botones rápidos) directamente en la etiqueta de script HTML:

```html
<script 
  src="http://localhost:5173/src/embed.jsx" 
  data-portal-id="el-retiro"
  data-welcome="¡Hola! Bienvenido al portal digital de El Retiro. 🌲"
  data-color="#15803d"
  data-replies="🇨🇴 Trámite de Sisbén,💵 Impuesto Predial,💬 Pregunta lo que quieras"
  defer
></script>
```

**Cómo procesarlo en el Widget:**
El cargador lee el script activo que fue inyectado y parsea las variables:
```javascript
const scriptTag = document.currentScript || document.querySelector('script[src*="embed.jsx"]');
const portalId = scriptTag?.getAttribute('data-portal-id') || 'default';
const welcomeMsg = scriptTag?.getAttribute('data-welcome') || '¡Hola!';
const quickReplies = scriptTag?.getAttribute('data-replies')?.split(',') || [];
```

---

### Enfoque B: Configuración por Objeto Global (Window Bridge)
El portal cliente declara un objeto de JavaScript en el ámbito global `window` antes de importar el chatbot:

```html
<script>
  window.ChatbotConfig = {
    portalId: "el-retiro",
    theme: {
      primaryColor: "#15803d",
      accentColor: "#d97706"
    },
    welcomeMessage: "Bienvenido al portal digital de atención ciudadana.",
    quickReplies: [
      { text: "🇨🇴 Consultar Sisbén", action: "sisben" },
      { text: "💵 Pagar Predial", action: "predial" }
    ]
  };
</script>

<script src="http://localhost:5173/src/embed.jsx" defer></script>
```

**Cómo procesarlo en el Widget:**
El inicializador del estado del chatbot busca el objeto `window.ChatbotConfig` y configura el renderizado inicial y las acciones en base a este.

---

### Enfoque C: Configuración Dinámica por API (Recomendado para SaaS Real)
El script de inyección únicamente indica el identificador del portal:
```html
<script src="https://chatbot-service.a.run.app/embed.js?portalId=el-retiro" defer></script>
```

**Flujo en Servidor:**
1. Al cargar la burbuja, el chatbot realiza una llamada de red:
   `GET https://chatbot-service.a.run.app/api/config?portalId=el-retiro`
2. El servidor (Cloud Run) consulta en base de datos (ej. Firestore/PostgreSQL) las configuraciones de ese `portalId` y responde un JSON con:
   * Paleta de colores y estilos.
   * Lista de **Quick Replies** y flujos interactivos activos.
   * **System Prompt para Gemini** adaptado al cliente (ej. *"Eres el asistente virtual de la Alcaldía de El Retiro. Responde de forma muy corta..."*).
   * URL de los endpoints de la API del cliente para procesar los trámites de Predial, Sisbén o RPA de forma descentralizada.
3. El chatbot monta la interfaz autoconfigurándose con esta respuesta de red.

---

## 2. Solución al Error de Integración en Next.js (Fast Refresh Preamble)
Al inyectar un script del servidor de desarrollo de Vite en un entorno de desarrollo de otra tecnología (como Next.js con Turbopack), ocurre el error:
`@vitejs/plugin-react can't detect preamble. Something is wrong.`

### Causa:
El plugin de React para Vite requiere inicializar las variables de recarga rápida en caliente (`Fast Refresh Preamble`) en el navegador receptor antes de ejecutar cualquier script del dev server.

### Solución en Entorno Local (Desarrollo):
Debes envolver el bloque de script en el archivo `layout.js` (o `layout.tsx`) utilizando la sintaxis de React para Next.js:

```jsx
export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        {children}

        {/* 1. Inicialización del Preamble de Vite en desarrollo local */}
        <script
          type="module"
          dangerouslySetInnerHTML={{
            __html: `
              import RefreshRuntime from 'http://localhost:5173/@react-refresh'
              RefreshRuntime.injectIntoGlobalHook(window)
              window.$RefreshReg$ = () => {}
              window.$RefreshSig$ = () => (type) => type
              window.__vite_plugin_react_preamble_installed__ = true
            `
          }}
        />

        {/* 2. Carga del script del Chatbot */}
        <script type="module" src="http://localhost:5173/src/embed.jsx" />
      </body>
    </html>
  );
}
```

### Solución para Producción:
En producción, al ejecutar `npm run build` en el proyecto del chatbot, el compilador de Vite deshabilita el Fast Refresh y une el código en JS nativo estándar.
En este caso, la integración se simplifica a una sola línea y no requiere ningún tipo de Preamble:
```html
<script type="module" src="https://tu-chatbot-service.a.run.app/dist/assets/index-xxxx.js"></script>
```
