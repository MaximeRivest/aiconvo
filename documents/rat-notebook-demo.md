# Notebook demo

First cell sets state:

```python
x = 10
print("x set to", x)
```

```output
x set to 10
```

Second cell uses it:

```python
print("x is", x)
```

```output
x is 10
```

Third cell fails on purpose:

```python
import time
time.sleep(600)
print("done")
```

```output
Traceback (most recent call last):
  File "/home/maxime/.cache/rat/kernels/py@aiconvo/python-kernel.py", line 805, in run_code
    exec(compile(tree, "<rat>", "exec"), namespace, namespace)
     ~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "<rat>", line 1, in <module>
ValueError: boom
```

Fourth cell must NOT run in run-all:

```python
print("should not appear")
```
