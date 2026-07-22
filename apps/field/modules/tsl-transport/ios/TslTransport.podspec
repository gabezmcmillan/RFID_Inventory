Pod::Spec.new do |s|
  s.name           = 'TslTransport'
  s.version        = '1.0.0'
  s.summary        = 'TSL ASCII 2.0 reader transport over iOS External Accessory'
  s.description   = 'TSL ASCII 2.0 reader transport over iOS External Accessory'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ExternalAccessory provides EASession / EAAccessoryManager.
  s.frameworks = 'ExternalAccessory'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
