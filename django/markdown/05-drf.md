# 05 · REST APIs with DRF

> **In one line:** Build JSON APIs with serializers, viewsets, and routers.

---

## 1. Overview

**Django REST Framework (DRF)** is the standard for JSON APIs. **Serializers** validate and convert between models and JSON; **ViewSets** bundle CRUD actions; **routers** auto-generate URLs. It also provides authentication, permissions, throttling, and pagination.

## 2. Key Concepts

- ModelSerializer auto-maps model fields to JSON.
- ViewSet groups list/create/retrieve/update/destroy.
- Routers wire ViewSets to RESTful URLs.
- Permissions/authentication classes guard endpoints.
- Pagination/filtering/throttling are pluggable.

## 3. Syntax & Code

```python
from rest_framework import serializers, viewsets, routers
class BookSerializer(serializers.ModelSerializer):
    class Meta:
        model = Book
        fields = ['id', 'title', 'author']

class BookViewSet(viewsets.ModelViewSet):
    queryset = Book.objects.select_related('author')
    serializer_class = BookSerializer

router = routers.DefaultRouter()
router.register('books', BookViewSet)
```

## 4. Worked Example

**Custom validation**

Add field/object validation in the serializer:

```python
class BookSerializer(serializers.ModelSerializer):
    def validate_title(self, value):
        if len(value) < 3:
            raise serializers.ValidationError('Title too short')
        return value
```

## 5. Best Practices

- ✅ Use ModelSerializer for CRUD; explicit serializers for custom shapes.
- ✅ Set permission_classes per ViewSet.
- ✅ Optimize ViewSet querysets (select_related/prefetch).
- ✅ Paginate list endpoints.
- ✅ Version your API (URL or header).

## 6. Common Pitfalls

1. ⚠️ fields = '__all__' leaking sensitive columns.
2. ⚠️ N+1 queries inside serializers (optimize the queryset).
3. ⚠️ Missing permissions leaving endpoints open.
4. ⚠️ Heavy logic in serializers vs services.
5. ⚠️ Not validating input, trusting the client.
6. ⚠️ Returning full objects where a slim serializer suffices.

## 7. Interview Questions

1. **Q: What does a serializer do?**
   A: Validates and converts between complex types (model instances) and JSON, both directions.

2. **Q: ViewSet vs APIView?**
   A: ViewSet bundles CRUD actions and pairs with routers; APIView gives explicit method control.

3. **Q: How are DRF URLs generated?**
   A: Routers register ViewSets and produce RESTful URL patterns.

4. **Q: How to secure endpoints?**
   A: authentication_classes (who) + permission_classes (what they can do).

5. **Q: How to avoid leaking fields?**
   A: List explicit fields, not '__all__'; use read_only/write_only.

6. **Q: How to optimize API DB access?**
   A: Set the ViewSet queryset with select_related/prefetch_related.

7. **Q: Where to put custom validation?**
   A: validate_<field>/validate() in the serializer.

8. **Q: How to paginate?**
   A: Configure DEFAULT_PAGINATION_CLASS or set pagination_class on the view.

## 8. Practice

- [ ] Expose a model as a ModelViewSet with a router.
- [ ] Add field-level validation to a serializer.
- [ ] Add token auth + IsAuthenticated permission.

## 9. Quick Revision

DRF: serializers (validate/convert), ViewSets (CRUD), routers (URLs), plus auth/permissions/pagination. List explicit fields, optimize querysets, secure every endpoint.

**References:** Django REST Framework

---

*Django Handbook — topic 05.*
