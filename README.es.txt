Conecta tus dispositivos Fox ESS a Homey a través de FoxCloud. FoxCloud se actualiza cada cinco minutos.

Dispositivos compatibles:
- Inversor: potencia y producción solar, potencia del inversor, potencia de respaldo (EPS), estado y fallos activos. Puedes fijar el límite de inyección a la red.
- Batería: estado de carga y de salud, potencia, energía cargada y descargada, temperatura y ciclos. Homey puede cargar y descargar la batería a una potencia fijada, y puedes ajustar el modo de trabajo y los límites de SoC.
- Medidor de red: potencia por fase, energía importada y exportada, tensión, frecuencia y consumo de la casa.
- Bomba de calor (beta): modo de funcionamiento y ajustes de agua caliente, de momento solo lectura.

Requisitos: tu instalación debe estar en una cuenta de FoxCloud. Crea una clave API en FoxCloud en Perfil de usuario > Gestión de API e introdúcela al añadir un dispositivo.

⚠️ Otros gestores de energía: FoxCloud, tu instalador, un proveedor de energía (VPP) u otra aplicación pueden retomar de Homey el control de la batería y del límite de inyección. Homey muestra entonces «Control anulado» y les deja el control hasta que vuelvas a cambiar un ajuste. Para controlar la batería desde Homey, asegúrate de que nada más la controle (pregunta a tu instalador o proveedor de energía).
