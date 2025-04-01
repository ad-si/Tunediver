// DOMinate extended by Adrian Sieber

interface DOMAttributes {
    [key: string]: string;
}

export type DOMElement = HTMLElement | SVGElement;
type DOMContentItem = string | DOMElement | DOMAttributes;
type DOMArray = Array<DOMContentItem | Array<DOMContentItem>>;

function DOMinate(
    a: DOMArray,
    ns: string = 'http://www.w3.org/1999/xhtml',
    b?: string,
    c?: number,
    d?: Document
): DOMElement {

    d = document;

    function e(
        aStr: string,
        b?: DOMElement
    ): DOMElement {
        const parts = aStr.split('#');
        b = d!.createElementNS(ns, parts[0]) as DOMElement;
        const idAndClass = parts[1] ? parts[1].split('.') : ['', ''];
        b.id = idAndClass[0] || '';
        if (idAndClass[1]) {
            b.setAttribute('class', idAndClass[1]);
        }
        return b;
    }

    if (typeof a[0] === 'string') {
        a[0] = e(a[0] as string);
    }

    for (c = 1; c < a.length; c++) {
        const item = a[c];
        
        if (typeof item === 'string') {
            (a[0] as DOMElement).appendChild(d!.createTextNode(item));
        } else if (Array.isArray(item)) {
            if (typeof item[0] === 'string') {
                item[0] = e(item[0] as string);
            }
            (a[0] as DOMElement).appendChild(item[0] as DOMElement);
            DOMinate(item as DOMArray, ns);
        } else if (item && typeof item === 'object') {
            for (const key in item as DOMAttributes) {
                (a[0] as DOMElement).setAttribute(key, (item as DOMAttributes)[key]);
            }
        }
    }

    return a[0] as DOMElement;
}