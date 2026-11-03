#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <stdint.h>

/* Generated IDs are small; unsupported integer widths use the Python parser. */
static int read_varint(const unsigned char *data, Py_ssize_t length,
                       Py_ssize_t *offset, uint64_t *value) {
    unsigned int shift = 0;
    *value = 0;
    while (*offset < length) {
        unsigned char byte = data[(*offset)++];
        if (shift >= 63) {
            PyErr_SetString(PyExc_OverflowError, "wide varint needs Python decoder");
            return -1;
        }
        *value |= (uint64_t)(byte & 127) << shift;
        if (!(byte & 128)) return 0;
        shift += 7;
    }
    PyErr_SetString(PyExc_ValueError, "truncated varint");
    return -1;
}

static int bounded_end(Py_ssize_t offset, uint64_t size, Py_ssize_t length,
                       Py_ssize_t *end) {
    if (size > (uint64_t)(length - offset)) {
        PyErr_SetString(PyExc_ValueError, "truncated postings");
        return -1;
    }
    *end = offset + (Py_ssize_t)size;
    return 0;
}

static PyObject *read_entries(PyObject *self, PyObject *args) {
    Py_buffer buffer;
    Py_ssize_t offset, record_count;
    int materialize;
    unsigned long long entries;
    if (!PyArg_ParseTuple(args, "y*nKnp", &buffer, &offset, &entries,
                          &record_count, &materialize)) return NULL;
    PyObject *output = NULL, *key = NULL, *ids = NULL, *entry = NULL;
    const unsigned char *data = buffer.buf;
    if (offset < 0 || offset > buffer.len || record_count < 0) {
        PyErr_SetString(PyExc_ValueError, "invalid posting bounds");
        goto done;
    }
    output = PyDict_New();
    if (!output) goto done;
    for (unsigned long long i = 0; i < entries; i++) {
        uint64_t key_size, expected, size;
        Py_ssize_t end, start;
        if (read_varint(data, buffer.len, &offset, &key_size) < 0 ||
            bounded_end(offset, key_size, buffer.len, &end) < 0) goto failed;
        key = PyUnicode_DecodeUTF8((const char *)data + offset, end - offset, "strict");
        if (!key) goto failed;
        offset = end;
        if (read_varint(data, buffer.len, &offset, &expected) < 0 ||
            read_varint(data, buffer.len, &offset, &size) < 0 ||
            bounded_end(offset, size, buffer.len, &end) < 0) goto failed;
        start = offset;
        uint64_t previous = 0, count = 0;
        int first = 1;
        if (materialize) {
            ids = PySet_New(NULL);
            if (!ids) goto failed;
        }
        while (offset < end) {
            uint64_t delta;
            if (read_varint(data, end, &offset, &delta) < 0) goto failed;
            if (previous >= (uint64_t)record_count ||
                delta >= (uint64_t)record_count - previous) {
                PyErr_SetString(PyExc_ValueError, "posting record id out of range");
                goto failed;
            }
            previous += delta;
            if (first || delta) {
                count++;
                if (materialize) {
                    PyObject *id = PyLong_FromUnsignedLongLong(previous);
                    if (!id) goto failed;
                    int status = PySet_Add(ids, id);
                    Py_DECREF(id);
                    if (status < 0) goto failed;
                }
            }
            first = 0;
        }
        if (count != expected) {
            PyErr_SetString(PyExc_ValueError, "posting count mismatch");
            goto failed;
        }
        if (materialize) { entry = ids; ids = NULL; }
        else entry = Py_BuildValue("nnK", start, end, (unsigned long long)expected);
        if (!entry || PyDict_SetItem(output, key, entry) < 0) goto failed;
        Py_CLEAR(entry);
        Py_CLEAR(key);
    }
    if (offset != buffer.len) {
        PyErr_SetString(PyExc_ValueError, "trailing postings");
        goto failed;
    }
    goto done;
failed:
    Py_CLEAR(output);
done:
    Py_XDECREF(key);
    Py_XDECREF(ids);
    Py_XDECREF(entry);
    PyBuffer_Release(&buffer);
    return output;
}

/* Decode a single packed posting, falling back for arbitrary-width integers. */
static PyObject *decode_postings(PyObject *self, PyObject *args) {
    Py_buffer buffer;
    if (!PyArg_ParseTuple(args, "y*", &buffer)) return NULL;
    const unsigned char *data = buffer.buf;
    Py_ssize_t offset = 0;
    uint64_t previous = 0;
    PyObject *output = PySet_New(NULL);
    if (!output) goto done;
    while (offset < buffer.len) {
        uint64_t delta;
        if (read_varint(data, buffer.len, &offset, &delta) < 0) goto failed;
        if (delta > UINT64_MAX - previous) {
            PyErr_SetString(PyExc_OverflowError, "wide posting needs Python decoder");
            goto failed;
        }
        previous += delta;
        PyObject *id = PyLong_FromUnsignedLongLong(previous);
        if (!id) goto failed;
        int status = PySet_Add(output, id);
        Py_DECREF(id);
        if (status < 0) goto failed;
    }
    goto done;
failed:
    Py_CLEAR(output);
done:
    PyBuffer_Release(&buffer);
    return output;
}

static PyMethodDef methods[] = {
    {"read_entries", read_entries, METH_VARARGS, "Decode and fully validate posting entries."},
    {"decode_postings", decode_postings, METH_VARARGS, "Decode one packed posting list."},
    {NULL, NULL, 0, NULL}
};
static struct PyModuleDef module = {
    PyModuleDef_HEAD_INIT, "_search_index_native", NULL, -1, methods,
    NULL, NULL, NULL, NULL
};
PyMODINIT_FUNC PyInit__search_index_native(void) { return PyModule_Create(&module); }
