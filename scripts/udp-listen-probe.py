#!/usr/bin/env python3
"""Debug helper: log UDP datagrams as hex so a remote browser's STUN/TURN
requests can be observed (used during the AC4 WebKit investigation)."""
import socket, sys, binascii
port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", port))
print(f"udp-listen-probe on :{port}", flush=True)
while True:
    data, addr = sock.recvfrom(65535)
    print(f"from {addr[0]}:{addr[1]} len={len(data)} hex={binascii.hexlify(data[:64]).decode()}", flush=True)
