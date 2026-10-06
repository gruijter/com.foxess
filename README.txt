Connect your Fox ESS devices to Homey through FoxCloud. FoxCloud updates every five minutes.

Supported devices:
- Solar inverter: solar power and yield, inverter output, backup (EPS) power, status and active faults. You can set the export limit to the grid.
- Battery: state of charge and health, power, charged and discharged energy, temperature and cycles. Homey can charge and discharge the battery at a set power, and you can set the work mode and SoC limits.
- Grid meter: power per phase, imported and exported energy, voltage, frequency and home consumption.
- Heat pump (beta): operating mode and hot water settings, read-only for now.

Requirements: your installation must be in a FoxCloud account. Create an API key in FoxCloud under User Profile > API Management, and enter it when you add a device.

⚠️ Other energy managers: FoxCloud, your installer, an energy provider (VPP) or another app can take control of the battery and the export limit back from Homey. Homey then shows 'Control overridden' and leaves control to them until you change a setting again. To control the battery from Homey, make sure nothing else controls it (ask your installer or energy provider).
