import { registerWebModule, NativeModule } from 'expo';

// TslTransportModule is not available on the web platform.
class TslTransportModule extends NativeModule<{}> {}

export default registerWebModule(TslTransportModule, 'TslTransportModule');
