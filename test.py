import serial, time
ser = serial.Serial("/dev/cu.usbserial-1128_US_V01336", 115200, timeout=0.3)
time.sleep(0.2)
ser.reset_input_buffer()
ser.write(b".vr\r\n")          # version command — responds without needing a tag
end = time.time() + 2
while time.time() < end:
    line = ser.readline().decode(errors="ignore").strip()
    if line:
        print(repr(line))
ser.close()