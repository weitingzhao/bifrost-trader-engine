from ib_insync import *

ib = IB()
ib.connect('192.168.7.233', 7496, clientId=10)

print(ib.isConnected())
